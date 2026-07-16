import { ExecError } from "./exec-error.ts";
import type { ExecOptions, ExecResult } from "./run.ts";
import { redactSecrets } from "./secret-redaction.ts";

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

export interface HostCapability {
  reportRunLifecycle(runId: string, state: RunLifecycleState): Promise<boolean>;
  secrets(): Promise<Readonly<Record<string, string>>>;
  captureSecrets(runId: string): Promise<string>;
  restoreSecrets(runId: string, snapshot: string): Promise<Readonly<Record<string, string>>>;
  exec(
    request: Omit<Parameters<RunnerBridge["exec"]>[0], "secrets"> & {
      readonly secrets: Readonly<Record<string, string>>;
    },
  ): Promise<ExecResult>;
  destroy(runId: string, secrets: Readonly<Record<string, string>>): Promise<void>;
}

export type RunLifecycleState = "in_progress" | "success" | "failure";

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
  private readonly host: HostCapability;
  private readonly runId: string;
  private readonly secrets: Readonly<Record<string, string>>;

  constructor(host: HostCapability, runId: string, secrets: Readonly<Record<string, string>>) {
    this.host = host;
    this.runId = runId;
    this.secrets = secrets;
  }

  async exec(id: string, command: string | ExecOptions, durable: DurableExec): Promise<ExecResult> {
    const options = normalize(command);
    this.started = true;
    const result = await durable(
      async (step) =>
        await this.host.exec({
          runId: this.runId,
          step: { id, count: step.step.count, attempt: step.attempt },
          options,
          secrets: this.secrets,
        }),
    );
    if (result.exitCode !== 0) {
      const values = Object.values(this.secrets);
      throw new ExecError(id, redactSecrets(options.command, values), {
        ...result,
        stdout: redactSecrets(result.stdout, values),
        stderr: redactSecrets(result.stderr, values),
      });
    }
    return result;
  }

  async cleanup(): Promise<void> {
    if (!this.started || this.cleaned) return;
    await this.host.destroy(this.runId, this.secrets);
    this.cleaned = true;
  }
}
