import { expect, test } from "vitest";

import { Meter } from "../src/internal/meter.ts";
import {
  RunLostError,
  Sandbox,
  type DurableCache,
  type DurableStep,
} from "../src/internal/sandbox/sandbox.ts";
import { source } from "../src/internal/source/source.ts";
import { Terminal } from "../src/internal/terminal.ts";
import type { TerminalRecord, TerminalState } from "../src/internal/terminal.ts";
import { makeStep } from "../src/step.ts";

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

test("one bounded meter observes source, cache, command, and Sandbox lifecycle", async () => {
  const meter = new Meter({ priceTable: { id: "test", rates: [] } });
  const revision = "f".repeat(40);
  const sandbox = new Sandbox({
    runId: "unreported-run-id",
    secrets: {},
    meter,
    terminal: terminalFixture(),
    source: source(
      {
        repositoryId: "unreported-repository-id",
        remote: "https://github.com/acme/example",
        revision,
      },
      { prepare: async () => prepared(revision, 12) },
    ),
    placement: {
      cache: async () => ({ result: { state: "miss", reason: "absent" } }),
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 7 }),
      destroy: async () => {},
    },
  });

  await sandbox.cache(durableCache("tree"), { key: "v1", path: ".tree" });
  await sandbox.exec(durable("check"), "secret command");
  await sandbox.cleanup();

  const report = meter.report();
  expect(report.samples).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "source", state: "prepared", bytes: 12 }),
      expect.objectContaining({ type: "sandbox", phase: "ready" }),
      expect.objectContaining({ type: "cache", state: "miss", bytes: 0 }),
      { type: "exec", state: "finished", count: 1, durationMs: 7 },
      expect.objectContaining({ type: "sandbox", phase: "destroy" }),
    ]),
  );
  expect(JSON.stringify(report)).not.toContain("unreported");
  expect(JSON.stringify(report)).not.toContain("secret command");
});

test("reconnect latency does not double-count the original command duration", async () => {
  let now = 0;
  const meter = new Meter({ priceTable: { id: "test", rates: [] }, now: () => ++now });
  const revision = "f".repeat(40);
  const sandbox = new Sandbox({
    runId: "run-reconnect-meter",
    secrets: {},
    meter,
    terminal: terminalFixture(),
    source: source(
      { repositoryId: "repository-1", remote: "https://github.com/acme/example", revision },
      { prepare: async () => prepared(revision) },
    ),
    placement: {
      exec: async () => {
        throw new Error("recorded commands do not execute");
      },
      destroy: async () => {},
    },
  });
  const recorded: DurableStep = {
    id: "recorded",
    run: async (digest) => ({
      digest,
      result: { exitCode: 0, stdout: "", stderr: "", durationMs: 99_999 },
      callback: "recorded",
    }),
  };

  await sandbox.exec(recorded, "build");

  expect(meter.report().samples).toContainEqual({
    type: "exec",
    state: "reconnected",
    count: 1,
    durationMs: 1,
  });
});

test("continuity loss and failed destroy attempts are each metered once", async () => {
  let now = 0;
  const meter = new Meter({
    priceTable: {
      id: "test",
      rates: [
        { source: "container", unit: "vcpu-ms", usdPerUnit: 0 },
        { source: "container", unit: "gib-ms", usdPerUnit: 0 },
        { source: "container", unit: "disk-gb-ms", usdPerUnit: 0 },
      ],
    },
    container: { vcpu: 0.5, memoryGib: 4, diskGb: 8 },
    now: () => ++now,
  });
  const revision = "f".repeat(40);
  const sandbox = new Sandbox({
    runId: "run-loss-meter",
    secrets: {},
    meter,
    terminal: terminalFixture(),
    source: source(
      { repositoryId: "repository-1", remote: "https://github.com/acme/example", revision },
      { prepare: async () => prepared(revision) },
    ),
    placement: {
      exec: async () => {
        throw new RunLostError("placement replaced");
      },
      destroy: async () => {
        throw new Error("destroy unavailable");
      },
    },
  });

  await expect(sandbox.exec(durable("build"), "build")).rejects.toThrow("placement replaced");
  await expect(sandbox.exec(durable("later"), "later")).rejects.toThrow("placement replaced");
  await expect(sandbox.cleanup()).rejects.toThrow("destroy unavailable");

  expect(meter.report().samples).toEqual(
    expect.arrayContaining([
      { type: "loss", startedCommands: 1 },
      expect.objectContaining({ type: "sandbox", phase: "destroy", count: 1 }),
      expect.objectContaining({
        type: "usage",
        source: "container",
        unit: "vcpu-ms",
        quantity: 1.5,
        provenance: "allocated",
      }),
    ]),
  );
});

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

const durableCache = (id: string): DurableCache => ({
  id,
  run: async (digest, work) => ({ digest, record: await work() }),
});

const cacheSandbox = (options: {
  readonly cache?: NonNullable<ConstructorParameters<typeof Sandbox>[0]["placement"]["cache"]>;
  readonly discardCaches?: NonNullable<
    ConstructorParameters<typeof Sandbox>[0]["placement"]["discardCaches"]
  >;
  readonly destroy?: () => void;
  readonly exec?: NonNullable<ConstructorParameters<typeof Sandbox>[0]["placement"]["exec"]>;
  readonly prepareCaches?: NonNullable<
    ConstructorParameters<typeof Sandbox>[0]["placement"]["prepareCaches"]
  >;
  readonly terminal?: Terminal;
}) => {
  const revision = "e".repeat(40);
  return new Sandbox({
    runId: "run-cache",
    secrets: {},
    terminal: options.terminal ?? terminalFixture(),
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      { prepare: async () => prepared(revision) },
    ),
    placement: {
      ...(options.cache ? { cache: options.cache } : {}),
      ...(options.discardCaches ? { discardCaches: options.discardCaches } : {}),
      ...(options.prepareCaches ? { prepareCaches: options.prepareCaches } : {}),
      exec: options.exec ?? (async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 })),
      destroy: async () => options.destroy?.(),
    },
  });
};

test("a cache miss prepares the exact source and leaves execution available", async () => {
  const revision = "f".repeat(40);
  const events: string[] = [];
  const sandbox = new Sandbox({
    runId: "run-cache-miss",
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
          events.push(`prepare:${revision}`);
          return prepared(revision);
        },
      },
    ),
    placement: {
      cache: async ({ source: exact }) => {
        events.push(`cache:${exact.result.revision}`);
        return { result: { state: "miss", reason: "absent" } };
      },
      exec: async ({ command }) => {
        events.push(`exec:${command.command}`);
        return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1 };
      },
      destroy: async () => {},
    },
  });

  await expect(sandbox.cache(durableCache("tree"), { key: "v1", path: ".tree" })).resolves.toEqual({
    state: "miss",
    reason: "absent",
  });
  await expect(sandbox.exec(durable("build"), "build")).resolves.toMatchObject({ exitCode: 0 });
  expect(events).toEqual([`prepare:${revision}`, `cache:${revision}`, "exec:build"]);
});

test("an unavailable cache placement is an advisory miss", async () => {
  const sandbox = cacheSandbox({});

  await expect(
    sandbox.cache(durableCache("unavailable"), { key: "v1", path: "/cache/unavailable" }),
  ).resolves.toEqual({ state: "miss", reason: "unavailable" });
});

test("cache sets retain only the trees needed for publication", async () => {
  const exact = { state: "hit", bytes: 12, key: "v1", match: "exact" } as const;
  const scenarios = [
    { results: [exact], prepared: 0, discarded: [] },
    { results: [exact, exact], prepared: 2, discarded: [] },
    {
      results: [{ ...exact, key: "v0", match: "restore" as const }],
      prepared: 1,
      discarded: [],
    },
    {
      results: [exact, { state: "miss", reason: "absent" } as const],
      prepared: 2,
      discarded: ["/cache/0"],
    },
  ];
  for (const scenario of scenarios) {
    let result = 0;
    let prepared = 0;
    const discarded: string[] = [];
    const sandbox = cacheSandbox({
      cache: async ({ id }) => ({
        result: scenario.results[result++]!,
        pending: { schema: 1, id } as never,
      }),
      discardCaches: async ({ paths }) => {
        discarded.push(...paths);
      },
      prepareCaches: async ({ pending }) => {
        prepared = pending.length;
        return [];
      },
    });
    const paths = scenario.results.map((_, index) => `/cache/${index}`);
    await sandbox.cacheSet(
      "tree",
      { key: "v1", restoreKeys: ["v"], paths: [paths[0]!, ...paths.slice(1)] },
      durableCache,
    );
    await sandbox.prepare();
    expect({ prepared, discarded }).toEqual({
      prepared: scenario.prepared,
      discarded: scenario.discarded,
    });
  }
});

test("cache declarations are canonical, retryable, disjoint, safe, and ordered before exec", async () => {
  const stored = new Map<
    string,
    {
      readonly digest: string;
      readonly record: { readonly result: { state: "miss"; reason: "absent" } };
    }
  >();
  const recorded = (id: string): DurableCache => ({
    id,
    run: async (digest, work) => {
      const prior = stored.get(id);
      if (prior) return prior;
      const record = await work();
      if (record.result.state !== "miss") throw new Error("expected miss");
      const value = {
        digest,
        record: { result: { state: "miss" as const, reason: "absent" as const } },
      };
      stored.set(id, value);
      return value;
    },
  });
  const sandbox = cacheSandbox({
    cache: async () => ({ result: { state: "miss", reason: "absent" } }),
  });

  await expect(
    sandbox.cache(recorded("one"), {
      key: { files: ["inputs/a", "inputs/b"], prefix: "v1" },
      path: "./trees/one",
      budget: { maxDurationMs: 10, maxBytes: 20 },
    }),
  ).resolves.toMatchObject({ state: "miss" });
  await expect(
    sandbox.cache(recorded("one"), {
      path: "/workspace/trees/one",
      budget: { maxBytes: 20, maxDurationMs: 10 },
      key: { prefix: "v1", files: ["inputs/a", "inputs/b"] },
    }),
  ).resolves.toMatchObject({ state: "miss" });
  await expect(
    sandbox.cache(recorded("one"), { key: "changed", path: "/workspace/trees/one" }),
  ).rejects.toThrow("cache declaration collision");
  await expect(
    sandbox.cache(recorded("child"), { key: "v1", path: "/workspace/trees/one/child" }),
  ).rejects.toThrow("cache target overlaps");
  for (const path of [
    "../escape",
    "/workspace",
    "/cache",
    "/tmp/tree",
    ".git/objects",
    ".runway/state",
  ]) {
    await expect(sandbox.cache(recorded(`unsafe-${path}`), { key: "v1", path })).rejects.toThrow(
      "invalid cache target",
    );
  }
  await sandbox.exec(durable("execute"), "execute");
  await expect(sandbox.cache(recorded("late"), { key: "v1", path: "/cache/late" })).rejects.toThrow(
    "before command execution",
  );
});

test("durable cache replays reject changed declarations and malformed results", async () => {
  const sandbox = cacheSandbox({
    cache: async () => ({ result: { state: "miss", reason: "absent" } }),
  });
  await expect(
    sandbox.cache(
      {
        id: "changed",
        run: async (_digest, work) => ({ digest: "0".repeat(64), record: await work() }),
      },
      { key: "v1", path: "/cache/changed" },
    ),
  ).rejects.toThrow("declaration changed");
  await expect(
    sandbox.cache(
      {
        id: "malformed",
        run: async (digest) => ({
          digest,
          record: { result: { state: "hit", bytes: -1 } as never },
        }),
      },
      { key: "v1", path: "/cache/malformed" },
    ),
  ).rejects.toThrow("invalid durable cache result");
});

test("a cache-only Sandbox is cleaned after a restore attempt", async () => {
  let destroys = 0;
  const sandbox = cacheSandbox({
    cache: async () => ({ result: { state: "miss", reason: "absent" } }),
    destroy: () => {
      destroys += 1;
    },
  });

  await sandbox.cache(durableCache("only"), { key: "v1", path: "/cache/only" });
  await sandbox.cleanup();
  expect(destroys).toBe(1);
});

test("a recorded cache replay still cleans the run placement", async () => {
  let destroys = 0;
  const sandbox = cacheSandbox({
    cache: async () => {
      throw new Error("recorded cache callback must not repeat");
    },
    destroy: () => {
      destroys += 1;
    },
  });
  const recorded: DurableCache = {
    id: "recorded",
    run: async (digest) => ({
      digest,
      record: { result: { state: "miss", reason: "absent" } },
    }),
  };

  await sandbox.cache(recorded, { key: "v1", path: "/cache/recorded" });
  await sandbox.cleanup();
  expect(destroys).toBe(1);
});

test("only a verified success publishes durable cache evidence after one quiesce and cleanup", async () => {
  const events: string[] = [];
  const terminal = terminalFixture();
  const pending = { schema: 1, id: "tree" } as never;
  const preparedCache = { state: "ready", pending, object: { digest: "a".repeat(64) } } as never;
  const sandbox = new Sandbox({
    runId: "run-1",
    secrets: {},
    terminal,
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision: "a".repeat(40),
      },
      { prepare: async () => prepared("a".repeat(40)) },
    ),
    placement: {
      cache: async () => ({
        result: { state: "miss", reason: "absent" },
        pending,
      }),
      quiesce: async () => {
        events.push("quiesce");
      },
      prepareCaches: async ({ pending: observed }) => {
        events.push(`prepare:${observed.length}`);
        return [preparedCache];
      },
      publishCaches: async ({ finalization, prepared: snapshots }) => {
        events.push(`publish:${finalization.outcome}:${snapshots.length}`);
      },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      destroy: async () => {
        events.push("destroy");
      },
    },
  });

  await sandbox.cache(durableCache("tree"), { key: "v1", path: "/cache/tree" });
  const snapshots = await sandbox.prepare();
  expect(events).toEqual(["quiesce", "prepare:1"]);
  await sandbox.cleanup();
  expect(events).toEqual(["quiesce", "prepare:1", "destroy"]);
  const success = await terminal.claim("success");
  await sandbox.finish(success, snapshots);
  expect(events).toEqual(["quiesce", "prepare:1", "destroy", "publish:success:1"]);
});

test.each(["failure", "cancelled"] as const)(
  "%s discards pending cache evidence without preparing or publishing a ref",
  async (outcome) => {
    const events: string[] = [];
    const terminal = terminalFixture();
    const sandbox = new Sandbox({
      runId: "run-1",
      secrets: {},
      terminal,
      source: source(
        {
          repositoryId: "repository-1",
          remote: "https://github.com/acme/example",
          revision: "a".repeat(40),
        },
        { prepare: async () => prepared("a".repeat(40)) },
      ),
      placement: {
        cache: async () => ({
          result: { state: "miss", reason: "absent" },
          pending: { schema: 1, id: "tree" } as never,
        }),
        quiesce: async () => {
          events.push("quiesce");
        },
        prepareCaches: async () => {
          events.push("prepare");
          return [];
        },
        publishCaches: async () => {
          events.push("publish");
        },
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
        destroy: async () => {
          events.push("destroy");
        },
      },
    });

    await sandbox.cache(durableCache("tree"), { key: "v1", path: "/cache/tree" });
    await sandbox.finish(await terminal.claim(outcome));
    expect(events).toEqual(["destroy"]);
  },
);

test("a lost cache publication response retries idempotently and exhausted failure stays advisory", async () => {
  const terminal = terminalFixture();
  const events: string[] = [];
  const sandbox = new Sandbox({
    runId: "run-1",
    secrets: {},
    terminal,
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision: "a".repeat(40),
      },
      { prepare: async () => prepared("a".repeat(40)) },
    ),
    placement: {
      publishCaches: async () => {
        events.push("cas");
      },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      destroy: async () => {
        events.push("destroy");
      },
    },
  });
  const ready = [{ state: "ready" }] as never;
  const winner = await terminal.claim("success");

  await expect(
    sandbox.finish(winner, ready, {
      run: async (work) => {
        await work();
        events.push("response-lost");
        await work();
      },
    }),
  ).resolves.toBeUndefined();
  expect(events).toEqual(["cas", "response-lost", "cas"]);

  await expect(
    sandbox.finish(winner, ready, {
      run: async () => {
        throw new Error("publication retries exhausted");
      },
    }),
  ).resolves.toBeUndefined();
  expect(events).toEqual(["cas", "response-lost", "cas"]);
});

test("a success with no ready cache evidence runs neither prepare nor publication", async () => {
  const terminal = terminalFixture();
  let publications = 0;
  const sandbox = cacheSandbox({ terminal });
  await expect(sandbox.prepare()).resolves.toEqual([]);
  await sandbox.finish(await terminal.claim("success"), [], {
    run: async () => {
      publications += 1;
    },
  });
  expect(publications).toBe(0);
});

test("a cache-free run does not spend a process quiescence barrier", async () => {
  const sandbox = cacheSandbox({
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
  });
  await expect(sandbox.prepare()).resolves.toEqual([]);
  expect(sandbox.hasPendingCaches()).toBe(false);
});

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
  const run = makeStep(
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
      cache: async (id, declaration) =>
        await sandbox.cache(durableCache(id), { ...declaration, path: declaration.paths[0] }),
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
