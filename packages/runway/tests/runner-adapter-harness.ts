import { WorkerEntrypoint } from "cloudflare:workers";

import { createRunnerAdapter } from "../src/runner-adapter.ts";
import { repositoryFixture } from "./repository-fixture.ts";

const repository = repositoryFixture;
const repositoryMarker = "/tmp/runway-repository";
const repositoryHead = "/workspace/.git/HEAD";

interface HarnessProcess {
  id: string;
  command: string;
  status: string;
  startTime: Date;
  exitCode?: number | undefined;
}

interface SandboxHooks {
  exists?(path: string, sandbox: TestSandbox): Promise<{ exists: boolean }>;
  getProcess?(id: string, sandbox: TestSandbox): Promise<HarnessProcess | null>;
  startProcess?(
    command: string,
    options: { processId: string },
    sandbox: TestSandbox,
  ): Promise<HarnessProcess>;
  streamProcessLogs?(id: string, sandbox: TestSandbox): Promise<ReadableStream<Uint8Array>>;
  killProcess?(id: string, signal: string | undefined, sandbox: TestSandbox): Promise<void>;
  destroy?(sandbox: TestSandbox): Promise<void>;
}

const processStream = (events: ReadonlyArray<unknown>): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });

class TestSandbox {
  process: HarnessProcess | null = null;
  starts = 0;
  commands: string[] = [];
  streams = 0;
  kills: Array<{ id: string; signal?: string }> = [];
  destroys = 0;
  files = new Map<string, string>();

  constructor(private readonly hooks: SandboxHooks = {}) {}

  async getProcess(id: string): Promise<HarnessProcess | null> {
    return this.hooks.getProcess
      ? await this.hooks.getProcess(id, this)
      : this.process?.id === id
        ? this.process
        : null;
  }

  async startProcess(command: string, options: { processId: string }): Promise<HarnessProcess> {
    this.starts += 1;
    this.commands.push(command);
    this.process = this.hooks.startProcess
      ? await this.hooks.startProcess(command, options, this)
      : {
          id: options.processId,
          command,
          status: "running",
          startTime: new Date(),
        };
    return this.process;
  }

  async streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>> {
    this.streams += 1;
    return this.hooks.streamProcessLogs
      ? await this.hooks.streamProcessLogs(id, this)
      : processStream([]);
  }

  async killProcess(id: string, signal?: string): Promise<void> {
    this.kills.push(signal === undefined ? { id } : { id, signal });
    await this.hooks.killProcess?.(id, signal, this);
  }

  async killAllProcesses(): Promise<number> {
    return 0;
  }

  async destroy(): Promise<void> {
    this.destroys += 1;
    await this.hooks.destroy?.(this);
  }

  async exists(path: string): Promise<{ exists: boolean }> {
    return this.hooks.exists ? await this.hooks.exists(path, this) : { exists: this.hasPath(path) };
  }

  async readFile(path: string): Promise<{ success: boolean; content: string }> {
    const content = this.files.get(path);
    return content === undefined ? { success: false, content: "" } : { success: true, content };
  }

  replace(): void {
    this.process = null;
    this.files.clear();
  }

  hasPath(path: string): boolean {
    return (
      this.files.has(path) || [...this.files.keys()].some((file) => file.startsWith(`${path}/`))
    );
  }
}

const requestOf = (
  command: string,
  options: {
    runId?: string;
    stepId?: string;
    attempt?: number;
    timeoutMs?: number;
    secrets?: ReadonlyArray<string>;
  } = {},
) => ({
  runId: options.runId ?? "run-harness",
  step: { id: options.stepId ?? "command", count: 1, attempt: options.attempt ?? 1 },
  options: {
    command,
    cwd: "/workspace",
    env: { CI: "true" },
    timeoutMs: options.timeoutMs ?? 1000,
  },
  secrets: options.secrets ?? [],
});

const adapterOf = (
  sandbox: TestSandbox,
  log: (chunk: string) => void = () => {},
  prepared = true,
) => {
  if (prepared) {
    sandbox.files.set(repositoryMarker, JSON.stringify(repository));
    sandbox.files.set(repositoryHead, repository.commit);
  }
  return createRunnerAdapter({
    sandbox: async () => sandbox,
    repository,
    log: ({ chunk }) => log(chunk),
  });
};

export class RunnerAdapterHarness extends WorkerEntrypoint<Cloudflare.Env> {
  async concurrentRepositoryBootstrap(): Promise<unknown> {
    let markerChecks = 0;
    let release = (): void => {};
    const checked = new Promise<void>((resolve) => (release = resolve));
    let checkoutRuns = 0;
    let commandRuns = 0;
    const checkoutProcesses = new Map<string, HarnessProcess>();
    const sandbox = new TestSandbox({
      exists: async (path) => {
        if (path !== repositoryMarker) {
          return { exists: sandbox.hasPath(path) };
        }
        if (sandbox.files.has(path)) return { exists: true };
        markerChecks += 1;
        if (markerChecks === 2) release();
        await checked;
        return { exists: false };
      },
      startProcess: async (command, options, current) => {
        if (options.processId.startsWith("checkout-")) {
          if (checkoutProcesses.has(options.processId)) throw new Error("duplicate process");
          checkoutRuns += 1;
          current.files.set(repositoryMarker, JSON.stringify(repository));
          current.files.set(repositoryHead, repository.commit);
          current.files.set("/tmp/runway-checkout-generation", "1");
        } else {
          commandRuns += 1;
        }
        const process = {
          id: options.processId,
          command,
          status: "completed",
          startTime: new Date(),
          exitCode: 0,
        };
        if (options.processId.startsWith("checkout-")) {
          checkoutProcesses.set(options.processId, process);
        }
        return process;
      },
      getProcess: async (id, current) =>
        checkoutProcesses.get(id) ?? (current.process?.id === id ? current.process : null),
      streamProcessLogs: async () => processStream([{ type: "exit", exitCode: 0 }]),
    });
    const adapter = adapterOf(sandbox, () => {}, false);

    await Promise.all([
      adapter.exec(requestOf("first", { runId: "run-concurrent", stepId: "first" })),
      adapter.exec(requestOf("second", { runId: "run-concurrent", stepId: "second" })),
    ]);

    return { checkoutRuns, commandRuns };
  }

  async repositoryRecovery(): Promise<unknown> {
    let checkoutRuns = 0;
    let commandRuns = 0;
    const commitsSeen: Array<string | undefined> = [];
    const sandbox = new TestSandbox({
      startProcess: async (command, options, current) => {
        if (options.processId.startsWith("checkout-")) {
          checkoutRuns += 1;
          current.files.set(repositoryMarker, JSON.stringify(repository));
          current.files.set(repositoryHead, repository.commit);
          current.files.set("/tmp/runway-checkout-generation", "1");
        } else {
          commandRuns += 1;
          commitsSeen.push(current.files.get(repositoryHead));
        }
        return {
          id: options.processId,
          command,
          status: "completed",
          startTime: new Date(),
          exitCode: 0,
        };
      },
      streamProcessLogs: async () => processStream([{ type: "exit", exitCode: 0 }]),
    });
    const adapter = adapterOf(sandbox, () => {}, false);

    await adapter.exec(requestOf("first", { runId: "run-repository", stepId: "first" }));
    await adapter.exec(requestOf("second", { runId: "run-repository", stepId: "second" }));
    sandbox.replace();
    await adapter.exec(requestOf("third", { runId: "run-repository", stepId: "third" }));

    return {
      checkoutRuns,
      commandRuns,
      commitsSeen,
      repositoryFiles: [...sandbox.files.keys()].filter((path) => path.startsWith("/workspace/")),
    };
  }

  async retry(): Promise<unknown> {
    const sandbox = new TestSandbox({
      streamProcessLogs: async (_id, current) => {
        if (current.streams === 1) {
          return new ReadableStream({
            start(controller) {
              controller.error(new Error("stream disconnected"));
            },
          });
        }
        if (current.process) {
          current.process.status = "completed";
          current.process.exitCode = 0;
        }
        return processStream([
          { type: "stdout", data: "recovered\n" },
          { type: "exit", data: "", exitCode: 0 },
        ]);
      },
    });
    const adapter = adapterOf(sandbox);
    await adapter.exec(requestOf("pnpm test", { runId: "run-retry" })).catch(() => undefined);
    const result = await adapter.exec(requestOf("pnpm test", { runId: "run-retry", attempt: 2 }));
    return { result, starts: sandbox.starts, streams: sandbox.streams };
  }

  async boundedOutput(): Promise<unknown> {
    const secret = "streaming-secret";
    const logs: string[] = [];
    let pulls = 0;
    const events = [
      ...Array.from({ length: 20 }, () => ({ type: "stdout", data: "x".repeat(4096) })),
      { type: "stdout", data: secret.slice(0, 8) },
      { type: "stdout", data: `${secret.slice(8)}\n` },
      { type: "stdout", data: "😀" },
      { type: "stderr", data: `bad ${secret}\n` },
      { type: "exit", data: "", exitCode: 0 },
    ];
    const sandbox = new TestSandbox({
      streamProcessLogs: async () => {
        const encoder = new TextEncoder();
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            const event = events[pulls++];
            if (event) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            else controller.close();
          },
        });
      },
    });
    const result = await adapterOf(sandbox, (chunk) => logs.push(chunk)).exec(
      requestOf("large", { runId: "run-stream", stepId: "large-output", secrets: [secret] }),
    );
    const allLogs = logs.join("");
    return {
      result,
      stdoutBytes: new TextEncoder().encode(result.stdout).byteLength,
      pulls,
      logsContainSecret: allLogs.includes(secret),
      logsContainMask: allLogs.includes("***"),
    };
  }

  async sandboxErrors(): Promise<unknown> {
    const secret = "sandbox-secret";
    const errors: unknown[] = [];
    for (const stage of ["sandbox", "getProcess", "startProcess"] as const) {
      let lookups = 0;
      const sandbox = new TestSandbox({
        getProcess: async () => {
          lookups += 1;
          if (stage === "getProcess") throw new Error(`getProcess exposed ${secret}`);
          return null;
        },
        startProcess: async () => {
          throw new Error(`startProcess exposed ${secret}`);
        },
      });
      sandbox.files.set(repositoryMarker, JSON.stringify(repository));
      sandbox.files.set(repositoryHead, repository.commit);
      try {
        await createRunnerAdapter({
          sandbox: async () => {
            if (stage === "sandbox") throw new Error(`sandbox exposed ${secret}`);
            return sandbox;
          },
          repository,
          log: () => {},
        }).exec(requestOf(`echo ${secret}`, { runId: "run-error", secrets: [secret] }));
      } catch (error) {
        errors.push(
          error instanceof Error
            ? { stage, name: error.name, message: error.message, stack: error.stack, lookups }
            : { stage, message: String(error), lookups },
        );
      }
    }
    try {
      await adapterOf(
        new TestSandbox({
          destroy: async () => Promise.reject(new Error(`destroy exposed ${secret}`)),
        }),
      ).destroy("run-error", [secret]);
    } catch (error) {
      errors.push({
        stage: "destroy",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return errors;
  }

  async timeout(): Promise<unknown> {
    const sandbox = new TestSandbox({
      streamProcessLogs: async (_id, current) =>
        current.streams === 1
          ? new ReadableStream<Uint8Array>({ pull() {} })
          : processStream([{ type: "exit", data: "", exitCode: 0 }]),
    });
    try {
      await adapterOf(sandbox).exec(
        requestOf("sleep forever", { runId: "run-timeout", stepId: "timeout", timeoutMs: 5 }),
      );
      return null;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        commands: sandbox.commands,
        killed: sandbox.kills,
      };
    }
  }

  async terminationCleanup(): Promise<unknown> {
    let watcher: Promise<void> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    const sandbox = new TestSandbox({
      streamProcessLogs: async () =>
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
        }),
      killProcess: async () => {
        controller?.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "exit", data: "", exitCode: 137 })}\n\n`),
        );
        controller?.close();
      },
      destroy: async () => Promise.reject(new Error("termination exposed termination-secret")),
    });
    sandbox.files.set(repositoryMarker, JSON.stringify(repository));
    sandbox.files.set(repositoryHead, repository.commit);
    const result = await createRunnerAdapter({
      sandbox: async () => sandbox,
      repository,
      log: () => {},
      status: async () => ({ status: "terminated" }),
      waitUntil: (promise) => (watcher = promise),
    }).exec(
      requestOf("block", {
        runId: "run-terminated",
        stepId: "block",
        timeoutMs: 5000,
        secrets: ["termination-secret"],
      }),
    );
    let watcherError: string | undefined;
    try {
      await watcher;
    } catch (error) {
      watcherError = error instanceof Error ? error.message : String(error);
    }
    return {
      result,
      kills: sandbox.kills.length,
      destroys: sandbox.destroys,
      watcherError,
    };
  }
}
