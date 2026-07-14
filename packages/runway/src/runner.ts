import { ExecError } from "./exec-error.ts";
import { redactSecrets } from "./secret-redaction.ts";
import type { ExecOptions, ExecResult } from "./types.ts";

const DEFAULT_EXEC_CWD = "/workspace";
const DEFAULT_EXEC_TIMEOUT_MS = 15 * 60_000;

export interface NormalizedExecOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface RunnerBridge {
  exec(request: {
    readonly runId: string;
    readonly step: { readonly id: string; readonly count: number; readonly attempt: number };
    readonly options: NormalizedExecOptions;
    readonly secrets: ReadonlyArray<string>;
  }): Promise<ExecResult>;
  destroy(runId: string, secrets: ReadonlyArray<string>): Promise<void>;
}

type DurableExec = (
  callback: (step: {
    readonly step: { readonly count: number };
    readonly attempt: number;
  }) => Promise<ExecResult>,
) => Promise<ExecResult>;

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
    const result = await durable(
      async (step) =>
        await bridge.exec({
          runId: this.runId,
          step: { id, count: step.step.count, attempt: step.attempt },
          options,
          secrets: this.secrets,
        }),
    );
    if (result.exitCode !== 0) {
      throw new ExecError(id, redactSecrets(options.command, this.secrets), {
        ...result,
        stdout: redactSecrets(result.stdout, this.secrets),
        stderr: redactSecrets(result.stderr, this.secrets),
      });
    }
    return result;
  }

  async cleanup(): Promise<void> {
    if (!this.started || this.cleaned || !this.bridge) return;
    await this.bridge.destroy(this.runId, this.secrets);
    this.cleaned = true;
  }
}
