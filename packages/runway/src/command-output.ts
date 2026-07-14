import type {
  ExecOptions as SandboxExecOptions,
  ExecResult as SandboxExecResult,
} from "@cloudflare/sandbox";

import type { NormalizedExecOptions } from "./runner.ts";
import type { ExecResult } from "./types.ts";

export const MAX_EXEC_OUTPUT_CHARS = 64 * 1024;

interface SandboxExecutor {
  exec(
    command: string,
    options: Pick<SandboxExecOptions, "cwd" | "env" | "timeout"> & {
      stream: true;
      onOutput(stream: "stdout" | "stderr", chunk: string): void;
    },
  ): Promise<Pick<SandboxExecResult, "exitCode" | "duration">>;
}

interface ManagedSandbox extends SandboxExecutor {
  killAllProcesses(): Promise<void>;
}

class Redactor {
  private pending = "";
  private readonly values: ReadonlyArray<string>;
  private readonly maxLength: number;

  constructor(values: ReadonlyArray<string>) {
    this.values = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
    this.maxLength = this.values[0]?.length ?? 0;
  }

  push(chunk: string): string {
    this.pending += chunk;
    return this.drain(false);
  }

  flush(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    if (this.maxLength === 0) {
      const output = this.pending;
      this.pending = "";
      return output;
    }
    let output = "";
    let consumed = 0;
    const limit = final
      ? this.pending.length
      : Math.max(0, this.pending.length - this.maxLength + 1);
    while (consumed < limit) {
      const secret = this.values.find((value) => this.pending.startsWith(value, consumed));
      if (secret) {
        output += "***";
        consumed += secret.length;
      } else {
        output += this.pending[consumed];
        consumed += 1;
      }
    }
    this.pending = this.pending.slice(consumed);
    return output;
  }
}

const appendTail = (tail: string, chunk: string): string =>
  `${tail}${chunk}`.slice(-MAX_EXEC_OUTPUT_CHARS);

export const executeSandboxCommand = async (
  sandbox: ManagedSandbox,
  options: NormalizedExecOptions,
  secrets: ReadonlyArray<string>,
  log: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<ExecResult> => {
  const redactors = { stdout: new Redactor(secrets), stderr: new Redactor(secrets) };
  let stdout = "";
  let stderr = "";
  const write = (stream: "stdout" | "stderr", chunk: string): void => {
    if (!chunk) return;
    log(stream, chunk);
    if (stream === "stdout") stdout = appendTail(stdout, chunk);
    else stderr = appendTail(stderr, chunk);
  };
  let result: { exitCode: number; duration: number };
  try {
    result = await sandbox.exec(options.command, {
      cwd: options.cwd,
      env: { ...options.env },
      timeout: options.timeoutMs,
      stream: true,
      onOutput: (stream, chunk) => write(stream, redactors[stream].push(chunk)),
    });
  } catch (error) {
    await sandbox.killAllProcesses();
    throw error;
  } finally {
    write("stdout", redactors.stdout.flush());
    write("stderr", redactors.stderr.flush());
  }
  return { exitCode: result.exitCode, stdout, stderr, durationMs: result.duration };
};

interface CancellationSandbox {
  killAllProcesses(): Promise<unknown>;
  destroy(): Promise<unknown>;
}

export const watchWorkflowCancellation = async (
  statusOf: () => Promise<{ status: string }>,
  sandbox: CancellationSandbox,
  completed: () => boolean,
  intervalMs = 1_000,
): Promise<void> => {
  while (!completed()) {
    await scheduler.wait(intervalMs);
    if (completed()) return;
    const status = await statusOf().catch(() => undefined);
    if (completed()) return;
    if (status?.status === "terminated") {
      await sandbox.killAllProcesses();
      await sandbox.destroy();
      return;
    }
  }
};
