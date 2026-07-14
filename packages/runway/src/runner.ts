import { ExecError } from "./exec-error.ts";
import type { ExecOptions, ExecResult } from "./types.ts";

const DEFAULT_EXEC_CWD = "/workspace";
const DEFAULT_EXEC_TIMEOUT_MS = 15 * 60_000;

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

type DurableExec = (callback: () => Promise<ExecResult>) => Promise<ExecResult>;

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
  private readonly bridge: RunnerBridge | undefined;
  private readonly runId: string;
  private readonly secrets: ReadonlyArray<string>;

  constructor(bridge: RunnerBridge | undefined, runId: string, secrets: ReadonlyArray<string>) {
    this.bridge = bridge;
    this.runId = runId;
    this.secrets = secrets;
  }

  async exec(id: string, command: string | ExecOptions, durable: DurableExec): Promise<ExecResult> {
    const options = normalize(command);
    const bridge = this.bridge;
    if (!bridge) throw new Error("missing runner binding: RUNWAY_RUNNER");
    this.started = true;
    const result = await durable(async () => await bridge.exec(this.runId, options, this.secrets));
    if (result.exitCode !== 0) {
      throw new ExecError(id, options.command, result);
    }
    return result;
  }

  async cleanup(): Promise<void> {
    if (!this.started || this.cleaned || !this.bridge) return;
    await this.bridge.destroy(this.runId);
    this.cleaned = true;
  }
}
