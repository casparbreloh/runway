import { parseSSEStream } from "@cloudflare/sandbox";

import type { RunnerBridge } from "./runner.ts";
import { redactError, StreamingRedactor } from "./secret-redaction.ts";
import type { ExecResult } from "./types.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type RunnerRequest = Parameters<RunnerBridge["exec"]>[0];
interface SandboxProcess {
  readonly id: string;
  readonly command: string;
  readonly status: string;
  readonly startTime: Date;
  readonly endTime?: Date | undefined;
  readonly exitCode?: number | undefined;
}

interface RunnerSandbox {
  getProcess(id: string): Promise<SandboxProcess | null>;
  startProcess(
    command: string,
    options: {
      processId: string;
      autoCleanup: false;
      cwd: string;
      env: Record<string, string>;
    },
  ): Promise<SandboxProcess>;
  streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>>;
  killProcess(id: string, signal?: string): Promise<void>;
  killAllProcesses(): Promise<unknown>;
  destroy(): Promise<unknown>;
}

interface RunnerLog {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly stream: "stdout" | "stderr";
  readonly chunk: string;
}

interface RunnerAdapterOptions {
  readonly sandbox: (runnerId: string) => RunnerSandbox | Promise<RunnerSandbox>;
  readonly log: (entry: RunnerLog) => void;
  readonly status?: (runId: string) => Promise<{ status: string }>;
  readonly waitUntil?: (promise: Promise<void>) => void;
}

const hashId = async (prefix: string, parts: ReadonlyArray<string | number>): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.map(String).join("\0")),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}-${hash.slice(0, 32)}`;
};

const appendTail = (tail: string, chunk: string): string => {
  const bytes = encoder.encode(`${tail}${chunk}`);
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) return decoder.decode(bytes);
  let start = bytes.byteLength - MAX_OUTPUT_BYTES;
  while ((bytes[start]! & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
};

const isTerminal = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "killed" || status === "error";

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const managedCommand = (command: string): string =>
  `child=; cleanup() { [ -z "$child" ] || kill -KILL -- -"$child" 2>/dev/null || true; }; trap cleanup EXIT; trap 'exit 143' TERM INT HUP; setsid sh -c ${shellQuote(command)} & child=$!; wait "$child"`;

const killProcessGroup = async (sandbox: RunnerSandbox, process: SandboxProcess): Promise<void> => {
  await sandbox.killProcess(process.id);
};

const cancellableDelay = (durationMs: number): { promise: Promise<void>; cancel(): void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(resolve, durationMs);
    }),
    cancel: () => clearTimeout(timer),
  };
};

const watchTermination = async (
  request: RunnerRequest,
  sandbox: RunnerSandbox,
  process: SandboxProcess,
  status: NonNullable<RunnerAdapterOptions["status"]>,
  completed: () => boolean,
  untilCompleted: Promise<void>,
): Promise<void> => {
  while (!completed()) {
    const delay = cancellableDelay(1000);
    await Promise.race([delay.promise, untilCompleted]);
    delay.cancel();
    if (completed()) return;
    const current = await status(request.runId).catch(() => undefined);
    if (completed()) return;
    if (current?.status === "terminated") {
      try {
        await killProcessGroup(sandbox, process);
      } finally {
        await sandbox.destroy();
      }
      return;
    }
  }
};

const collectResult = async (
  sandbox: RunnerSandbox,
  process: SandboxProcess,
  request: RunnerRequest,
  log: RunnerAdapterOptions["log"],
): Promise<ExecResult> => {
  const redactors = {
    stdout: new StreamingRedactor(request.secrets),
    stderr: new StreamingRedactor(request.secrets),
  };
  let stdout = "";
  let stderr = "";
  let exitCode = process.exitCode;
  const write = (stream: "stdout" | "stderr", chunk: string): void => {
    if (!chunk) return;
    log({
      runId: request.runId,
      stepId: request.step.id,
      attempt: request.step.attempt,
      stream,
      chunk,
    });
    if (stream === "stdout") stdout = appendTail(stdout, chunk);
    else stderr = appendTail(stderr, chunk);
  };
  const stream = await sandbox.streamProcessLogs(process.id);
  for await (const event of parseSSEStream<{
    type: "stdout" | "stderr" | "exit" | "complete" | "error";
    data?: string;
    exitCode?: number;
  }>(stream)) {
    if (event.type === "stdout" || event.type === "stderr") {
      write(event.type, redactors[event.type].push(event.data ?? ""));
    } else if (event.type === "exit" || event.type === "complete") {
      exitCode = event.exitCode ?? exitCode ?? 1;
    } else if (event.type === "error") {
      throw new Error(event.data ?? "process log stream failed");
    }
  }
  write("stdout", redactors.stdout.flush());
  write("stderr", redactors.stderr.flush());
  if (exitCode === undefined) {
    const refreshed = await sandbox.getProcess(process.id);
    exitCode = refreshed?.exitCode;
  }
  if (exitCode === undefined) throw new Error(`process ${process.id} ended without an exit code`);
  const endTime = process.endTime?.getTime() ?? Date.now();
  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Math.max(0, endTime - process.startTime.getTime()),
  };
};

export const createRunnerAdapter = (options: RunnerAdapterOptions): RunnerBridge => ({
  async exec(request) {
    let completed = false;
    let finish = (): void => {};
    const untilCompleted = new Promise<void>((resolve) => (finish = resolve));
    try {
      const runnerId = await hashId("runway", [request.runId]);
      const processId = await hashId("step", [request.runId, request.step.id, request.step.count]);
      const command = managedCommand(request.options.command);
      const sandbox = await options.sandbox(runnerId);
      let process = await sandbox.getProcess(processId);
      if (!process) {
        try {
          process = await sandbox.startProcess(command, {
            processId,
            autoCleanup: false,
            cwd: request.options.cwd,
            env: { ...request.options.env },
          });
        } catch (error) {
          process = await sandbox.getProcess(processId);
          if (!process) throw error;
        }
      }
      if (process.command !== command) {
        throw new Error(`process identity collision for step ${JSON.stringify(request.step.id)}`);
      }
      if (isTerminal(process.status)) {
        return await collectResult(sandbox, process, request, options.log);
      }
      if (options.status && options.waitUntil) {
        options.waitUntil(
          watchTermination(
            request,
            sandbox,
            process,
            options.status,
            () => completed,
            untilCompleted,
          ).catch((error) => {
            throw redactError(error, request.secrets);
          }),
        );
      }
      const elapsedMs = Math.max(0, Date.now() - process.startTime.getTime());
      const remainingMs = Math.max(0, request.options.timeoutMs - elapsedMs);
      const timeout = cancellableDelay(remainingMs);
      try {
        return await Promise.race([
          collectResult(sandbox, process, request, options.log),
          timeout.promise.then(async () => {
            await killProcessGroup(sandbox, process);
            throw new Error(`command timed out after ${request.options.timeoutMs}ms`);
          }),
        ]);
      } finally {
        timeout.cancel();
      }
    } catch (error) {
      throw redactError(error, request.secrets);
    } finally {
      completed = true;
      finish();
    }
  },
  async destroy(runId, secrets) {
    try {
      const sandbox = await options.sandbox(await hashId("runway", [runId]));
      try {
        await sandbox.killAllProcesses();
      } finally {
        await sandbox.destroy();
      }
    } catch (error) {
      throw redactError(error, secrets);
    }
  },
});
