import type {
  ExecOptions as SandboxExecOptions,
  ExecResult as SandboxExecResult,
} from "@cloudflare/sandbox";

import { ExecError } from "./exec-error.ts";
import type { ExecOptions, ExecResult } from "./types.ts";

export const DEFAULT_EXEC_CWD = "/workspace";
export const DEFAULT_EXEC_TIMEOUT_MS = 15 * 60_000;
export const MAX_EXEC_OUTPUT_CHARS = 64 * 1024;

export const runnerIdOf = async (runId: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runId));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `runway-${hash.slice(0, 32)}`;
};

export interface NormalizedExecOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface RunnerBridge {
  exec(
    runId: string,
    options: NormalizedExecOptions,
    secrets: ReadonlyArray<string>,
  ): Promise<ExecResult>;
  destroy(runId: string): Promise<void>;
}

export interface SandboxExecutor {
  exec(
    command: string,
    options: Pick<SandboxExecOptions, "cwd" | "env" | "timeout"> & {
      stream: true;
      onOutput(stream: "stdout" | "stderr", chunk: string): void;
    },
  ): Promise<Pick<SandboxExecResult, "exitCode" | "duration">>;
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
    while (this.pending.length > 0) {
      const secret = this.values.find((value) => this.pending.startsWith(value));
      if (secret) {
        output += "***";
        this.pending = this.pending.slice(secret.length);
      } else if (!final && this.pending.length < this.maxLength) {
        break;
      } else {
        output += this.pending[0];
        this.pending = this.pending.slice(1);
      }
    }
    return output;
  }
}

const appendTail = (tail: string, chunk: string): string =>
  `${tail}${chunk}`.slice(-MAX_EXEC_OUTPUT_CHARS);

export const executeCommand = async (
  sandbox: SandboxExecutor,
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
  } finally {
    write("stdout", redactors.stdout.flush());
    write("stderr", redactors.stderr.flush());
  }
  return { exitCode: result.exitCode, stdout, stderr, durationMs: result.duration };
};

const normalize = (command: string | ExecOptions): NormalizedExecOptions => {
  const options = typeof command === "string" ? { command } : command;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("exec timeoutMs must be a positive finite number");
  }
  return {
    command: options.command,
    cwd: options.cwd ?? DEFAULT_EXEC_CWD,
    env: { CI: "true", ...options.env },
    timeoutMs,
  };
};

export class ManagedRunner {
  private started = false;
  private cleaned = false;
  private readonly bridge: RunnerBridge;
  private readonly runId: string;
  private readonly secrets: ReadonlyArray<string>;

  constructor(bridge: RunnerBridge, runId: string, secrets: ReadonlyArray<string>) {
    this.bridge = bridge;
    this.runId = runId;
    this.secrets = secrets;
  }

  async exec(id: string, command: string | ExecOptions): Promise<ExecResult> {
    const options = normalize(command);
    this.activate();
    const result = await this.bridge.exec(this.runId, options, this.secrets);
    if (result.exitCode !== 0) {
      const timedOut =
        result.exitCode === 124 &&
        result.stderr.includes(`Command timed out after ${options.timeoutMs}ms`);
      throw new ExecError(id, options.command, result, timedOut);
    }
    return result;
  }

  activate(): void {
    this.started = true;
  }

  async cleanup(): Promise<void> {
    if (!this.started || this.cleaned) return;
    this.cleaned = true;
    await this.bridge.destroy(this.runId);
  }
}
