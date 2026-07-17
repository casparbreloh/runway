import { expect, test } from "vitest";

import { Meter } from "../src/meter.ts";
import { Terminal } from "../src/terminal.ts";
import type { TerminalRecord, TerminalState } from "../src/terminal.ts";

const identity = {
  accountId: "account-1",
  repositoryId: "repository-1",
  workflowId: "check",
  runId: "run-1",
  trustId: "trusted-default",
  generation: 3,
} as const;

const memory = (): TerminalState => {
  let winner: TerminalRecord | undefined;
  return {
    claim(candidate) {
      winner ??= structuredClone(candidate);
      return Promise.resolve(structuredClone(winner));
    },
    read() {
      return Promise.resolve(winner && structuredClone(winner));
    },
  };
};

test("terminal publication emits one structured run report", async () => {
  const reports: unknown[] = [];
  let now = 10;
  const meter = new Meter({
    priceTable: { id: "test", rates: [] },
    now: () => now,
    emit: (report) => {
      reports.push(structuredClone(report));
    },
  });
  const terminal = new Terminal(identity, memory(), async () => {}, { meter });
  now = 42;

  await terminal.publish(await terminal.claim("success"));

  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({
    schema: 1,
    samples: [{ type: "run", outcome: "success", count: 1, durationMs: 32 }],
  });
});

test("meter delivery is advisory and retries without duplicating the run sample", async () => {
  const reports: unknown[] = [];
  let attempts = 0;
  const meter = new Meter({
    priceTable: { id: "test", rates: [] },
    emit: (report) => {
      attempts += 1;
      if (attempts === 1) throw new Error("observability unavailable");
      reports.push(structuredClone(report));
    },
  });
  const terminal = new Terminal(identity, memory(), async () => {}, { meter });
  const winner = await terminal.claim("failure");

  await expect(terminal.publish(winner)).resolves.toBeUndefined();
  await expect(terminal.publish(winner)).resolves.toBeUndefined();

  expect(attempts).toBe(2);
  expect(reports).toHaveLength(1);
  expect((reports[0] as { samples: unknown[] }).samples).toEqual([
    expect.objectContaining({ type: "run", outcome: "failure", count: 1 }),
  ]);
});

test("the first terminal outcome wins", async () => {
  for (const outcome of ["success", "failure", "cancelled"] as const) {
    const terminal = new Terminal(identity, memory(), async () => {});

    await expect(terminal.claim(outcome)).resolves.toMatchObject({
      claimId: expect.any(String),
      outcome,
    });
  }
});

test("retrying the winning outcome returns the same finalization", async () => {
  const terminal = new Terminal(identity, memory(), async () => {});

  const winner = await terminal.claim("success");

  await expect(terminal.claim("success")).resolves.toEqual(winner);
});

test("a conflicting outcome returns the persisted winner", async () => {
  const terminal = new Terminal(identity, memory(), async () => {});
  const winner = await terminal.claim("failure");

  await expect(terminal.claim("success")).resolves.toEqual(winner);
  await expect(terminal.claim("cancelled")).resolves.toEqual(winner);
});

test("forged finalization fields cannot verify", async () => {
  const terminal = new Terminal(identity, memory(), async () => {});
  const winner = await terminal.claim("success");

  await expect(terminal.verify({ ...winner, outcome: "failure" })).rejects.toThrow(
    "terminal finalization does not match the durable winner",
  );
  await expect(
    terminal.verify({ ...winner, accountId: identity.accountId } as never),
  ).rejects.toThrow("invalid terminal finalization");
  await expect(
    terminal.verify({ claimId: crypto.randomUUID(), outcome: winner.outcome }),
  ).rejects.toThrow("terminal finalization does not match the durable winner");
});

test("an unknown claim cannot verify", async () => {
  const terminal = new Terminal(identity, memory(), async () => {});

  await expect(terminal.verify({ claimId: "unknown-claim", outcome: "success" })).rejects.toThrow(
    "unknown terminal claim",
  );
});

test("a winner cannot cross a bound terminal authority", async () => {
  const dimensions = [
    ["accountId", "account-2"],
    ["repositoryId", "repository-2"],
    ["workflowId", "test"],
    ["runId", "run-2"],
    ["trustId", "untrusted-fork"],
    ["generation", 4],
  ] as const;

  for (const [field, value] of dimensions) {
    const state = memory();
    const winner = await new Terminal(identity, state, async () => {}).claim("success");
    const other = new Terminal({ ...identity, [field]: value }, state, async () => {});

    await expect(other.verify(winner)).rejects.toThrow(
      "terminal claim belongs to a different authority",
    );
  }
});

test("the durable winner verifies after host redeploy and internal key rotation", async () => {
  const state = memory();
  const first = new Terminal(identity, state, async () => {});
  const winner = await first.claim("cancelled");
  const published: unknown[] = [];
  const redeployed = new Terminal(identity, state, async (finalization) => {
    published.push(finalization);
  });

  await expect(redeployed.publish(structuredClone(winner))).resolves.toBeUndefined();
  expect(published).toEqual([winner]);
});

test("retry after a lost claim response returns the durable winner", async () => {
  const durable = memory();
  let loseResponse = true;
  const state: TerminalState = {
    async claim(candidate) {
      const winner = await durable.claim(candidate);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("lost terminal response");
      }
      return winner;
    },
    read: () => durable.read(),
  };
  const terminal = new Terminal(identity, state, async () => {});

  await expect(terminal.claim("failure")).rejects.toThrow("lost terminal response");
  const retried = await terminal.claim("failure");
  await expect(terminal.verify(retried)).resolves.toBeUndefined();
});

test("only the verified durable winner reaches publication", async () => {
  const published: unknown[] = [];
  const terminal = new Terminal(identity, memory(), (finalization) => {
    published.push(structuredClone(finalization));
    return Promise.resolve();
  });
  const winner = await terminal.claim("success");

  await expect(terminal.publish({ claimId: winner.claimId, outcome: "failure" })).rejects.toThrow(
    "terminal finalization does not match the durable winner",
  );
  expect(published).toEqual([]);
  await terminal.publish(winner);
  expect(published).toEqual([winner]);
});
