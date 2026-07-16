import { expect, test } from "vitest";

import { makeRun } from "../src/run.ts";
import { RunLostError, Sandbox, type DurableStep } from "../src/sandbox.ts";
import { source } from "../src/source.ts";
import { Terminal } from "../src/terminal.ts";
import type { TerminalRecord, TerminalState } from "../src/terminal.ts";

const durable = (id: string, events?: string[]) => ({
  id,
  run: async (
    digest: string,
    work: (identity: { count: number; attempt: number }) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    }>,
  ) => {
    events?.push(`durable:${id}`);
    return {
      digest,
      result: await work({ count: 1, attempt: 1 }),
      callback: "executed" as const,
    };
  },
});

const prepared = (revision: string, bytes = 0, placement = "placement-witness") => ({
  placement,
  result: { revision, state: "prepared" as const, bytes },
});

const terminalFixture = () => {
  let winner: TerminalRecord | undefined;
  const state: TerminalState = {
    claim(candidate) {
      winner ??= structuredClone(candidate);
      return Promise.resolve(structuredClone(winner));
    },
    read() {
      return Promise.resolve(winner && structuredClone(winner));
    },
  };
  return new Terminal(
    {
      accountId: "account-1",
      repositoryId: "repository-1",
      workflowId: "check",
      runId: "run-1",
      trustId: "trusted-default",
      generation: 1,
    },
    state,
    async () => {},
  );
};

const recordedDurable = (): DurableStep => {
  let recorded:
    | {
        readonly digest: string;
        readonly result: { exitCode: number; stdout: string; stderr: string; durationMs: number };
      }
    | undefined;
  return {
    id: "recorded-command",
    run: async (digest, work) => {
      if (recorded) return { ...recorded, callback: "recorded" };
      const result = await work({ count: 1, attempt: 1 });
      recorded = { digest, result };
      return { ...recorded, callback: "executed" };
    },
  };
};

test("a recorded command rejects changed canonical options without starting again", async () => {
  const revision = "0".repeat(40);
  const step = recordedDurable();
  const starts: string[] = [];
  const createSandbox = () =>
    new Sandbox({
      runId: "run-recorded-command",
      secrets: {},
      terminal: terminalFixture(),
      source: source(
        {
          repositoryId: "repository-1",
          remote: "https://github.com/acme/example",
          revision,
        },
        { prepare: async () => prepared(revision) },
      ),
      placement: {
        exec: async ({ command }) => {
          starts.push(command.command);
          return { exitCode: 0, stdout: "first\n", stderr: "", durationMs: 1 };
        },
        destroy: async () => {},
      },
    });

  await expect(
    createSandbox().exec(step, { command: "build", env: { MODE: "one" } }),
  ).resolves.toMatchObject({ stdout: "first\n" });
  await expect(
    createSandbox().exec(step, { command: "build", env: { MODE: "two" } }),
  ).rejects.toBeInstanceOf(RunLostError);
  expect(starts).toEqual(["build"]);
});

test("canonical command evidence ignores env insertion order and distinguishes Unicode", async () => {
  const revision = "d".repeat(40);
  const step = recordedDurable();
  let starts = 0;
  const createSandbox = () =>
    new Sandbox({
      runId: "run-canonical-unicode",
      secrets: {},
      terminal: terminalFixture(),
      source: source(
        {
          repositoryId: "repository-1",
          remote: "https://github.com/acme/example",
          revision,
        },
        { prepare: async () => prepared(revision) },
      ),
      placement: {
        exec: async () => {
          starts += 1;
          return { exitCode: 0, stdout: "same\n", stderr: "", durationMs: 1 };
        },
        destroy: async () => {},
      },
    });

  await expect(
    createSandbox().exec(step, { command: "build", env: { z: "last", ä: "grün", a: "first" } }),
  ).resolves.toMatchObject({ stdout: "same\n" });
  await expect(
    createSandbox().exec(step, { command: "build", env: { a: "first", ä: "grün", z: "last" } }),
  ).resolves.toMatchObject({ stdout: "same\n" });
  await expect(
    createSandbox().exec(step, { command: "build", env: { a: "first", ä: "grün!", z: "last" } }),
  ).rejects.toBeInstanceOf(RunLostError);
  expect(starts).toBe(1);
});

test("a recorded command fences source reconstruction after runtime replacement", async () => {
  const revision = "a".repeat(40);
  const recorded = recordedDurable();
  let preparations = 0;
  let starts = 0;
  const makeSandbox = () =>
    new Sandbox({
      runId: "run-runtime-replacement",
      secrets: {},
      terminal: terminalFixture(),
      source: source(
        {
          repositoryId: "repository-1",
          remote: "https://github.com/acme/example",
          revision,
        },
        {
          prepare: async (_source, { allowReconstruct }) => {
            preparations += 1;
            if (!allowReconstruct) {
              throw new RunLostError("run continuity was lost: placement was replaced");
            }
            return prepared(revision);
          },
        },
      ),
      placement: {
        exec: async () => {
          starts += 1;
          return { exitCode: 0, stdout: "done\n", stderr: "", durationMs: 1 };
        },
        destroy: async () => {},
      },
    });

  await expect(makeSandbox().exec(recorded, "build")).resolves.toMatchObject({ stdout: "done\n" });
  const reconstructed = makeSandbox();
  await expect(reconstructed.exec(recorded, "build")).resolves.toMatchObject({ stdout: "done\n" });
  await expect(reconstructed.exec(durable("next"), "test")).rejects.toBeInstanceOf(RunLostError);
  expect({ preparations, starts }).toEqual({ preparations: 2, starts: 1 });
});

test("a lost Sandbox rejects every later command without source or placement activity", async () => {
  const revision = "b".repeat(40);
  let preparations = 0;
  let starts = 0;
  const sandbox = new Sandbox({
    runId: "run-lost-latch",
    secrets: {},
    terminal: terminalFixture(),
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      {
        prepare: async () => {
          preparations += 1;
          return prepared(revision);
        },
      },
    ),
    placement: {
      exec: async () => {
        starts += 1;
        throw new RunLostError("run continuity was lost: ambiguous start");
      },
      destroy: async () => {},
    },
  });

  await expect(sandbox.exec(durable("ambiguous"), "mutate")).rejects.toBeInstanceOf(RunLostError);
  await expect(sandbox.exec(durable("later"), "publish")).rejects.toBeInstanceOf(RunLostError);
  expect({ preparations, starts }).toEqual({ preparations: 1, starts: 1 });
});

test("known command outcomes stay honest and a later placement replacement is lost", async () => {
  const revision = "c".repeat(40);
  for (const outcome of ["success", "failed", "timed-out", "cancelled"] as const) {
    let replaced = false;
    const commands: string[] = [];
    const sandbox = new Sandbox({
      runId: `run-${outcome}`,
      secrets: {},
      terminal: terminalFixture(),
      source: source(
        {
          repositoryId: "repository-1",
          remote: "https://github.com/acme/example",
          revision,
        },
        { prepare: async () => prepared(revision) },
      ),
      placement: {
        exec: async ({ command }) => {
          commands.push(command.command);
          if (replaced) throw new RunLostError("run continuity was lost: placement changed");
          if (outcome === "failed") {
            return { exitCode: 7, stdout: "", stderr: "failed\n", durationMs: 1 };
          }
          if (outcome === "timed-out") throw new Error("command timed out after 5ms");
          if (outcome === "cancelled") throw new Error("command was cancelled");
          return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1 };
        },
        destroy: async () => {},
      },
    });

    const first = sandbox.exec(durable("first"), "first");
    if (outcome === "success") await expect(first).resolves.toMatchObject({ exitCode: 0 });
    else if (outcome === "failed") await expect(first).rejects.toMatchObject({ name: "ExecError" });
    else if (outcome === "timed-out") await expect(first).rejects.toThrow("timed out");
    else await expect(first).rejects.toThrow("cancelled");

    replaced = true;
    await expect(sandbox.exec(durable("next"), "next")).rejects.toBeInstanceOf(RunLostError);
    expect(commands).toEqual(["first", "next"]);
  }
});

test("invalid or non-immutable source revisions fail before placement mutation", async () => {
  for (const revision of ["main", "a".repeat(39), "g".repeat(40), "A".repeat(40)]) {
    let placementMutated = false;

    expect(() =>
      source(
        {
          repositoryId: "repository-1",
          remote: "https://github.com/acme/example",
          revision,
        },
        {
          prepare: async () => {
            placementMutated = true;
            return prepared(revision);
          },
        },
      ),
    ).toThrow("source revision must be an exact 40-character lowercase Git object id");
    expect(placementMutated).toBe(false);
  }
});

test("one exact public source prepares before one command executes", async () => {
  const revision = "1".repeat(40);
  const events: string[] = [];
  const exactSource = source(
    {
      repositoryId: "repository-1",
      remote: "https://github.com/acme/example",
      revision,
    },
    {
      prepare: async () => {
        events.push(`prepare:${revision}`);
        return prepared(revision, 123);
      },
    },
  );
  const sandbox = new Sandbox({
    runId: "run-1",
    secrets: {},
    terminal: terminalFixture(),
    source: exactSource,
    placement: {
      exec: async ({ source: prepared, command }) => {
        events.push(`exec:${prepared.result.revision}:${command.command}`);
        return {
          exitCode: 0,
          stdout: `${prepared.result.revision}\n`,
          stderr: "",
          durationMs: 4,
        };
      },
      destroy: async () => {},
    },
  });

  await expect(
    sandbox.exec(durable("checkout", events), {
      command: "git rev-parse HEAD",
      cwd: "/workspace",
      env: { CI: "true" },
      timeoutMs: 1000,
    }),
  ).resolves.toEqual({ exitCode: 0, stdout: `${revision}\n`, stderr: "", durationMs: 4 });
  expect(events).toEqual([
    "durable:checkout",
    `prepare:${revision}`,
    `exec:${revision}:git rev-parse HEAD`,
  ]);
});

test("source preparation validates state and transferred bytes after transport", async () => {
  const revision = "1".repeat(40);
  for (const result of [
    { revision, state: "unknown", bytes: 1 },
    { revision, state: "prepared", bytes: -1 },
    { revision, state: "prepared", bytes: 1.5 },
    { revision, state: "prepared", bytes: 1, credential: "must-not-cross" },
  ]) {
    const exactSource = source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      { prepare: async () => ({ placement: "placement-witness", result }) as never },
    );

    await expect(exactSource.prepare({ allowReconstruct: true })).rejects.toThrow(
      "source preparation result is invalid",
    );
  }
});

test("an authenticated source confines its purpose-scoped credential to checkout", async () => {
  const revision = "2".repeat(40);
  const token = "github-checkout-token";
  const issuerRequests: unknown[] = [];
  const checkoutEnvironments: Array<Record<string, string>> = [];
  const preparedSources: unknown[] = [];
  const metrics: unknown[] = [];
  const issueCredential = async (request: { purpose: "checkout"; repositoryId: string }) => {
    issuerRequests.push(request);
    return token;
  };
  const exactSource = source(
    {
      repositoryId: "github:17",
      remote: "https://github.com/acme/private",
      revision,
    },
    {
      prepare: async (preparedSource) => {
        preparedSources.push(preparedSource);
        let credential: string | undefined = await issueCredential({
          purpose: "checkout",
          repositoryId: preparedSource.repositoryId,
        });
        const environment = { RUNWAY_GITHUB_TOKEN: credential };
        checkoutEnvironments.push(environment);
        metrics.push({ type: "source", state: "prepared", bytes: 91 });
        credential = undefined;
        return prepared(revision, 91);
      },
    },
  );

  const result = await exactSource.prepare({ allowReconstruct: true });
  expect(issuerRequests).toEqual([{ purpose: "checkout", repositoryId: "github:17" }]);
  expect(preparedSources).toEqual([
    {
      repositoryId: "github:17",
      remote: "https://github.com/acme/private",
      revision,
    },
  ]);
  expect(checkoutEnvironments).toEqual([{ RUNWAY_GITHUB_TOKEN: token }]);
  expect(
    JSON.stringify({ source: exactSource, result, metrics, error: new Error("checkout failed") }),
  ).not.toContain(token);
  expect(exactSource.remote).toBe("https://github.com/acme/private");
});

test("do and sleep allocate no placement and cleanup destroys a lazy command placement", async () => {
  const revision = "3".repeat(40);
  let prepares = 0;
  let destroys = 0;
  const exactSource = source(
    {
      repositoryId: "repository-1",
      remote: "https://github.com/acme/example",
      revision,
    },
    {
      prepare: async () => {
        prepares += 1;
        return prepared(revision, 10);
      },
    },
  );
  const sandbox = new Sandbox({
    runId: "run-1",
    secrets: {},
    terminal: terminalFixture(),
    source: exactSource,
    placement: {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      destroy: async () => {
        destroys += 1;
      },
    },
  });
  const run = makeRun(
    {
      do: async (_id, work) => await work(),
      exec: async (id, command) =>
        await sandbox.exec(
          durable(id),
          typeof command === "string"
            ? { command, cwd: "/workspace", env: { CI: "true" }, timeoutMs: 1000 }
            : {
                cwd: "/workspace",
                env: { CI: "true" },
                timeoutMs: 1000,
                ...command,
              },
        ),
      sleep: async () => {},
    },
    { runId: "run-1", secrets: {} },
  );

  await run.do("local", () => "done");
  await run.sleep("pause", 1);
  await sandbox.cleanup();
  expect({ prepares, destroys }).toEqual({ prepares: 0, destroys: 0 });

  await run.exec("command", "true");
  await sandbox.cleanup();
  await sandbox.cleanup();
  expect({ prepares, destroys }).toEqual({ prepares: 1, destroys: 1 });
});

test("commands share one prepared source and preserve workspace mutation", async () => {
  const revision = "4".repeat(40);
  let preparations = 0;
  let workspace = "";
  const sandbox = new Sandbox({
    runId: "run-shared-workspace",
    secrets: {},
    terminal: terminalFixture(),
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      {
        prepare: async () => {
          preparations += 1;
          return prepared(revision, 10);
        },
      },
    ),
    placement: {
      exec: async ({ command }) => {
        if (command.command === "write") workspace = "preserved\n";
        return {
          exitCode: 0,
          stdout: command.command === "read" ? workspace : "",
          stderr: "",
          durationMs: 1,
        };
      },
      destroy: async () => {},
    },
  });

  await expect(sandbox.exec(durable("write"), "write")).resolves.toMatchObject({ exitCode: 0 });
  await expect(sandbox.exec(durable("read"), "read")).resolves.toMatchObject({
    stdout: "preserved\n",
  });
  expect(preparations).toBe(1);
});

test("a failed source preparation remains retryable", async () => {
  const revision = "5".repeat(40);
  let preparations = 0;
  const sandbox = new Sandbox({
    runId: "run-retry-preparation",
    secrets: {},
    terminal: terminalFixture(),
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      {
        prepare: async () => {
          preparations += 1;
          if (preparations === 1) throw new Error("transient preparation failure");
          return prepared(revision, 10);
        },
      },
    ),
    placement: {
      exec: async () => ({ exitCode: 0, stdout: "ready\n", stderr: "", durationMs: 1 }),
      destroy: async () => {},
    },
  });

  await expect(sandbox.exec(durable("first"), "true")).rejects.toThrow(
    "transient preparation failure",
  );
  await expect(sandbox.exec(durable("retry"), "true")).resolves.toMatchObject({
    stdout: "ready\n",
  });
  expect(preparations).toBe(2);
});

test("a nonzero result crosses the durable boundary once before becoming an ExecError", async () => {
  const revision = "6".repeat(40);
  let executions = 0;
  let durableResult: unknown;
  const sandbox = new Sandbox({
    runId: "run-nonzero",
    secrets: {},
    terminal: terminalFixture(),
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      { prepare: async () => prepared(revision) },
    ),
    placement: {
      exec: async () => {
        executions += 1;
        return { exitCode: 7, stdout: "", stderr: "failed\n", durationMs: 1 };
      },
      destroy: async () => {},
    },
  });

  await expect(
    sandbox.exec(
      {
        id: "fail",
        run: async (digest, work) => {
          durableResult = await work({ count: 1, attempt: 1 });
          return {
            digest,
            result: durableResult as never,
            callback: "executed" as const,
          };
        },
      },
      "exit 7",
    ),
  ).rejects.toMatchObject({ name: "ExecError", result: { exitCode: 7 } });
  expect({ durableResult, executions }).toEqual({
    durableResult: { exitCode: 7, stdout: "", stderr: "failed\n", durationMs: 1 },
    executions: 1,
  });
});

test("Sandbox finish accepts only a verified terminal winner", async () => {
  const revision = "7".repeat(40);
  const terminal = terminalFixture();
  const winner = await terminal.claim("success");
  let destroys = 0;
  const sandbox = new Sandbox({
    runId: "run-1",
    secrets: {},
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      { prepare: async () => prepared(revision) },
    ),
    placement: {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      destroy: async () => {
        destroys += 1;
      },
    },
    terminal,
  });
  await sandbox.exec(durable("build"), "build");

  await expect(sandbox.finish({ claimId: winner.claimId, outcome: "failure" })).rejects.toThrow(
    "terminal finalization does not match the durable winner",
  );
  expect(destroys).toBe(0);
  await expect(sandbox.finish(winner)).resolves.toBeUndefined();
  expect(destroys).toBe(1);
});

test("a failed finish cleanup remains retryable under the same winner", async () => {
  const revision = "8".repeat(40);
  const terminal = terminalFixture();
  const winner = await terminal.claim("failure");
  let attempts = 0;
  const sandbox = new Sandbox({
    runId: "run-1",
    secrets: {},
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      { prepare: async () => prepared(revision) },
    ),
    placement: {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      destroy: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient cleanup failure");
      },
    },
    terminal,
  });
  await sandbox.exec(durable("build"), "build");

  await expect(sandbox.finish(winner)).rejects.toThrow("transient cleanup failure");
  await expect(sandbox.finish(winner)).resolves.toBeUndefined();
  expect(attempts).toBe(2);
});

test("forced cleanup racing finish destroys one placement", async () => {
  const revision = "9".repeat(40);
  const terminal = terminalFixture();
  const winner = await terminal.claim("cancelled");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let destroys = 0;
  const sandbox = new Sandbox({
    runId: "run-1",
    secrets: {},
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      { prepare: async () => prepared(revision) },
    ),
    placement: {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      destroy: async () => {
        destroys += 1;
        await blocked;
      },
    },
    terminal,
  });
  await sandbox.exec(durable("build"), "build");

  const forced = sandbox.cleanup();
  const finished = sandbox.finish(winner);
  await Promise.resolve();
  release();
  await expect(Promise.all([forced, finished])).resolves.toEqual([undefined, undefined]);
  expect(destroys).toBe(1);
});
