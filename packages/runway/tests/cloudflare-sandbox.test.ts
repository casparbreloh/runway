import { expect, test, vi } from "vitest";

import { cloudflareSandbox } from "../src/cloudflare/sandbox.ts";
import { RunLostError, Sandbox } from "../src/sandbox.ts";
import { source } from "../src/source.ts";
import { authenticatedRepositoryFixture, repositoryFixture } from "./repository-fixture.ts";

interface Process {
  readonly id: string;
  readonly command: string;
  status: string;
  readonly startTime: Date;
  exitCode?: number;
}

interface Outcome {
  readonly events?: ReadonlyArray<unknown>;
  readonly lineEnding?: "\n" | "\r\n";
  readonly open?: boolean;
}

const eventStream = (
  events: ReadonlyArray<unknown>,
  lineEnding = "\n",
): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}${lineEnding}${lineEnding}`),
        );
      }
      controller.close();
    },
  });

class MemoryPlacement {
  readonly placement: string;
  readonly starts: string[] = [];
  readonly files = new Map<string, string>();
  readonly processes = new Map<string, Process>();
  readonly killed = new Set<string>();
  readonly environments: ReadonlyArray<Record<string, string>> = [];
  destroyed = false;
  #controllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  #outcomes: Outcome[];

  constructor(outcomes: Outcome[] = [], prepared = true, placement = "memory-placement-witness") {
    this.#outcomes = [...outcomes];
    this.placement = placement;
    if (prepared) this.#prepare(repositoryFixture);
  }

  #prepare(repository: typeof repositoryFixture, placement = this.placement): void {
    this.files.set("/tmp/runway-repository", JSON.stringify({ repository, placement }));
    this.files.set("/workspace/.git/HEAD", repository.commit);
    this.files.set("/tmp/runway-repository-metrics", JSON.stringify({ packBytes: 123 }));
  }

  exists(path: string): Promise<{ exists: boolean }> {
    return Promise.resolve({
      exists:
        this.files.has(path) || [...this.files.keys()].some((file) => file.startsWith(`${path}/`)),
    });
  }

  readFile(path: string): Promise<{ success: boolean; content: string }> {
    const content = this.files.get(path);
    return Promise.resolve(
      content === undefined ? { success: false, content: "" } : { success: true, content },
    );
  }

  getProcess(id: string): Promise<Process | null> {
    return Promise.resolve(this.processes.get(id) ?? null);
  }

  startProcess(
    command: string,
    options: {
      processId: string;
      autoCleanup: false;
      cwd: string;
      env: Record<string, string>;
    },
  ): Promise<Process> {
    if (this.processes.has(options.processId)) throw new Error("duplicate process");
    const checkout = options.cwd === "/";
    if (!checkout) this.starts.push(options.processId);
    const outcome = checkout ? {} : (this.#outcomes.shift() ?? {});
    const process: Process = {
      id: options.processId,
      command,
      status: outcome.open ? "running" : "completed",
      startTime: new Date(),
      ...(outcome.open ? {} : { exitCode: 0 }),
    };
    this.processes.set(process.id, process);
    if (checkout) {
      (this.environments as Array<Record<string, string>>).push({ ...options.env });
      const repository =
        options.env.RUNWAY_AUTHENTICATION_TOKEN_MINTED === "true"
          ? authenticatedRepositoryFixture
          : repositoryFixture;
      const placement = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/.exec(
        command,
      )?.[0];
      if (!placement) throw new Error("missing placement witness in checkout command");
      this.#prepare(repository, placement);
    }
    this.#outcomesByProcess.set(process.id, outcome);
    return Promise.resolve(process);
  }

  readonly #outcomesByProcess = new Map<string, Outcome>();

  streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>> {
    const outcome = this.#outcomesByProcess.get(id) ?? {};
    if (outcome.open) {
      return Promise.resolve(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            this.#controllers.set(id, controller);
          },
        }),
      );
    }
    return Promise.resolve(
      eventStream(outcome.events ?? [{ type: "exit", data: "", exitCode: 0 }], outcome.lineEnding),
    );
  }

  killProcess(id: string): Promise<void> {
    this.killed.add(id);
    const process = this.processes.get(id);
    if (process) {
      process.status = "killed";
      process.exitCode = 137;
    }
    const controller = this.#controllers.get(id);
    if (controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ type: "exit", data: "", exitCode: 137 })}\n\n`,
        ),
      );
      controller.close();
    }
    return Promise.resolve();
  }

  killAllProcesses(): Promise<void> {
    for (const id of this.processes.keys()) this.killed.add(id);
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.destroyed = true;
    return Promise.resolve();
  }
}

const command = (options: {
  readonly source?: typeof repositoryFixture;
  readonly secrets?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
}) => ({
  runId: "run-1",
  step: { id: "command", count: 1, attempt: 1 },
  options: {
    command: "command",
    cwd: "/workspace",
    env: { CI: "true" },
    timeoutMs: options.timeoutMs ?? 1000,
  },
  secrets: options.secrets ?? [],
  source: {
    placement: "memory-placement-witness",
    result: {
      revision: (options.source ?? repositoryFixture).commit,
      state: "prepared" as const,
      bytes: 0,
    },
  },
});

test("a durable retry reconnects to the exact recorded process without another start", async () => {
  const placement = new MemoryPlacement([{}]);
  const sandbox = cloudflareSandbox({
    placement: () => placement,
    repository: repositoryFixture,
    log: () => {},
  });
  const request = command({});

  const first = await sandbox.execute(request);
  const retried = await sandbox.execute({
    ...request,
    step: { ...request.step, attempt: 2 },
  });

  expect({ first, retried, starts: placement.starts }).toEqual({
    first: { exitCode: 0, stdout: "", stderr: "", durationMs: expect.any(Number) },
    retried: { exitCode: 0, stdout: "", stderr: "", durationMs: expect.any(Number) },
    starts: [expect.any(String)],
  });
});

test("placement replacement before any user command reconstructs the exact source", async () => {
  let placement = new MemoryPlacement([], false, "first-empty-placement");
  const sandbox = cloudflareSandbox({
    placement: () => placement,
    repository: repositoryFixture,
    log: () => {},
  });

  const first = await sandbox.prepare({
    runId: "run-before-command",
    secrets: [],
    allowReconstruct: true,
  });
  placement = new MemoryPlacement([], false, "replacement-empty-placement");
  const reconstructed = await sandbox.prepare({
    runId: "run-before-command",
    secrets: [],
    allowReconstruct: true,
  });

  expect(reconstructed).toMatchObject({
    result: { revision: repositoryFixture.commit, state: "prepared" },
  });
  expect(reconstructed.placement).not.toBe(first.placement);
  expect(placement.environments).toHaveLength(1);
});

test("a fresh placement witness cannot authorize reconstruction after command evidence", async () => {
  let placement = new MemoryPlacement([], false, "original-empty-placement");
  const sandbox = cloudflareSandbox({
    placement: () => placement,
    repository: repositoryFixture,
    log: () => {},
  });
  const prepared = await sandbox.prepare({
    runId: "run-fenced-reconstruction",
    secrets: [],
    allowReconstruct: true,
  });

  placement = new MemoryPlacement([], false, "replacement-empty-placement");
  await expect(
    sandbox.prepare({
      runId: "run-fenced-reconstruction",
      secrets: [],
      allowReconstruct: false,
    }),
  ).rejects.toBeInstanceOf(RunLostError);
  expect(prepared.placement).not.toBe(placement.placement);
  expect(placement.environments).toEqual([]);
});

test("placement and command digest mismatches are lost without another start", async () => {
  let placement = new MemoryPlacement([{}]);
  const sandbox = cloudflareSandbox({
    placement: () => placement,
    repository: repositoryFixture,
    log: () => {},
  });
  const request = command({});
  await sandbox.execute(request);

  await expect(
    sandbox.execute({
      ...request,
      step: { ...request.step, attempt: 2 },
      options: { ...request.options, env: { CI: "true", MODE: "changed" } },
    }),
  ).rejects.toBeInstanceOf(RunLostError);
  expect(placement.starts).toHaveLength(1);

  placement = new MemoryPlacement([], true, "fresh-placement-witness");
  await expect(
    sandbox.execute({ ...request, step: { id: "next", count: 1, attempt: 1 } }),
  ).rejects.toBeInstanceOf(RunLostError);
  expect(placement.starts).toEqual([]);
});

test("an ambiguous command start response is lost when no exact process can be found", async () => {
  class AmbiguousPlacement extends MemoryPlacement {
    override startProcess(
      command: string,
      options: {
        processId: string;
        autoCleanup: false;
        cwd: string;
        env: Record<string, string>;
      },
    ): Promise<Process> {
      if (options.cwd !== "/") throw new Error("lost start response");
      return super.startProcess(command, options);
    }
  }
  const placement = new AmbiguousPlacement([{}]);
  const sandbox = cloudflareSandbox({
    placement: () => placement,
    repository: repositoryFixture,
    log: () => {},
  });

  await expect(sandbox.execute(command({}))).rejects.toBeInstanceOf(RunLostError);
  expect(placement.starts).toEqual([]);
});

test("output streams incrementally into bounded UTF-8 redacted tails", async () => {
  const secret = "streaming-secret";
  const logs: string[] = [];
  const placement = new MemoryPlacement([
    {
      lineEnding: "\r\n",
      events: [
        ...Array.from({ length: 20 }, () => ({ type: "stdout", data: "x".repeat(4096) })),
        { type: "stdout", data: secret.slice(0, 8) },
        { type: "stdout", data: `${secret.slice(8)}\n` },
        { type: "stdout", data: "😀" },
        { type: "stderr", data: `bad ${secret}\n` },
        { type: "exit", data: "", exitCode: 0 },
      ],
    },
  ]);
  const sandbox = cloudflareSandbox({
    placement: () => placement,
    repository: repositoryFixture,
    log: ({ chunk }) => logs.push(chunk),
  });

  const result = await sandbox.execute(command({ secrets: [secret] }));
  expect(new TextEncoder().encode(result.stdout)).toHaveLength(64 * 1024);
  expect(result.stderr).toBe("bad ***\n");
  expect(JSON.stringify({ result, logs })).not.toContain(secret);
  expect(logs.join("")).toContain("***");
});

test("timeout kills the active process group", async () => {
  const placement = new MemoryPlacement([{ open: true }]);
  const sandbox = cloudflareSandbox({
    placement: () => placement,
    repository: repositoryFixture,
    log: () => {},
  });

  await expect(sandbox.execute(command({ timeoutMs: 5 }))).rejects.toThrow(
    "command timed out after 5ms",
  );
  expect(placement.killed).toEqual(new Set(placement.processes.keys()));
});

test("workflow termination kills execution and destroys its placement", async () => {
  vi.useFakeTimers();
  try {
    const placement = new MemoryPlacement([{ open: true }]);
    let watcher: Promise<void> | undefined;
    const sandbox = cloudflareSandbox({
      placement: () => placement,
      repository: repositoryFixture,
      status: async () => ({ status: "terminated" }),
      waitUntil: (promise) => (watcher = promise),
      log: () => {},
    });

    const execution = sandbox.execute(command({ timeoutMs: 5000 }));
    while (!watcher) await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1001);
    await expect(execution).resolves.toMatchObject({ exitCode: 137 });
    await expect(watcher).resolves.toBeUndefined();
    expect({ killed: placement.killed.size, destroyed: placement.destroyed }).toEqual({
      killed: 1,
      destroyed: true,
    });
  } finally {
    vi.useRealTimers();
  }
});

test("concurrent first commands share source preparation and placement", async () => {
  const revision = repositoryFixture.commit;
  const placements = new Map<string, MemoryPlacement>();
  const transport = cloudflareSandbox({
    placement: (id) => {
      const existing = placements.get(id);
      if (existing) return existing;
      const placement = new MemoryPlacement([{}, {}], false);
      placements.set(id, placement);
      return placement;
    },
    repository: repositoryFixture,
    log: () => {},
  });
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let preparations = 0;
  const exactSource = source(
    {
      repositoryId: `remote:${repositoryFixture.remote}`,
      remote: repositoryFixture.remote,
      revision,
    },
    {
      prepare: async () => {
        preparations += 1;
        await gate;
        return await transport.prepare({
          runId: "run-concurrent",
          secrets: [],
          allowReconstruct: true,
        });
      },
    },
  );
  const sandbox = new Sandbox({
    runId: "run-concurrent",
    secrets: {},
    source: exactSource,
    placement: {
      exec: async ({ runId, step, command: options, source: prepared, secrets }) =>
        await transport.execute({ runId, step, options, source: prepared, secrets }),
      destroy: async () => {},
    },
  });
  const durable = (id: string) => ({
    id,
    run: async (
      digest: string,
      work: (identity: { count: number; attempt: number }) => Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
        durationMs: number;
      }>,
    ) => ({
      digest,
      result: await work({ count: 1, attempt: 1 }),
      callback: "executed" as const,
    }),
  });

  const first = sandbox.exec(durable("first"), "first");
  const second = sandbox.exec(durable("second"), "second");
  release();
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  expect({
    preparations,
    placements: placements.size,
    checkoutProcesses: [...placements.values()].flatMap((placement) => placement.environments)
      .length,
  }).toEqual({
    preparations: 1,
    placements: 1,
    checkoutProcesses: 1,
  });
});

test("checkout credentials remain confined to the checkout process", async () => {
  const token = "purpose-scoped-token";
  const logs: string[] = [];
  const placement = new MemoryPlacement([], false);
  const sandbox = cloudflareSandbox({
    placement: () => placement,
    repository: authenticatedRepositoryFixture,
    installationToken: async ({ purpose }) => {
      expect(purpose).toBe("checkout");
      return token;
    },
    log: ({ chunk }) => logs.push(chunk),
  });

  const result = await sandbox.prepare({
    runId: "private-run",
    secrets: [],
    allowReconstruct: true,
  });
  expect(placement.environments).toHaveLength(1);
  expect(placement.environments[0]?.RUNWAY_GITHUB_TOKEN).toBe(token);
  expect(JSON.stringify({ result, logs })).not.toContain(token);
  expect(result).toEqual({
    placement: expect.any(String),
    result: {
      revision: authenticatedRepositoryFixture.commit,
      state: "prepared",
      bytes: 123,
    },
  });
});

test("checkout failures redact the ephemeral credential", async () => {
  const token = "purpose-scoped-failure-token";
  class FailingPlacement extends MemoryPlacement {
    override startProcess(): Promise<Process> {
      throw new Error(`checkout transport exposed ${token}`);
    }
  }
  const sandbox = cloudflareSandbox({
    placement: () => new FailingPlacement([], false),
    repository: authenticatedRepositoryFixture,
    installationToken: async () => token,
    log: () => {},
  });

  let message = "";
  try {
    await sandbox.prepare({
      runId: "private-failure",
      secrets: [],
      allowReconstruct: true,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toBe("checkout transport exposed ***");
  expect(message).not.toContain(token);
});
