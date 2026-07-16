import { ExecError } from "./exec-error.ts";
import type { ExecOptions, ExecResult } from "./run.ts";
import { redactSecrets } from "./secret-redaction.ts";
import type { Source, SourceResult } from "./source.ts";

const DEFAULT_EXEC_CWD = "/workspace";
const DEFAULT_EXEC_TIMEOUT_MS = 15 * 60_000;

export interface NormalizedExecOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface DurableStep {
  readonly id: string;
  run(
    work: (identity: { readonly count: number; readonly attempt: number }) => Promise<ExecResult>,
    rollback: () => Promise<void>,
  ): Promise<ExecResult>;
}

export interface Placement {
  exec(request: {
    readonly runId: string;
    readonly step: {
      readonly id: string;
      readonly count: number;
      readonly attempt: number;
    };
    readonly source: SourceResult;
    readonly command: NormalizedExecOptions;
    readonly secrets: ReadonlyArray<string>;
  }): Promise<ExecResult>;
  destroy(runId: string, secrets: ReadonlyArray<string>): Promise<void>;
}

export class Sandbox {
  #cleaned = false;
  #preparation: Promise<SourceResult> | undefined;
  #started = false;
  readonly #placement: Placement;
  readonly #runId: string;
  readonly #secrets: ReadonlyArray<string>;
  readonly #source: Source;

  constructor(options: {
    readonly runId: string;
    readonly secrets: Readonly<Record<string, string>>;
    readonly source: Source;
    readonly placement: Placement;
  }) {
    this.#runId = options.runId;
    this.#secrets = Object.values(options.secrets);
    this.#source = options.source;
    this.#placement = options.placement;
  }

  #prepare(): Promise<SourceResult> {
    if (this.#preparation) return this.#preparation;
    const preparation = this.#source.prepare();
    this.#preparation = preparation;
    void preparation.catch(() => {
      if (this.#preparation === preparation) this.#preparation = undefined;
    });
    return preparation;
  }

  async exec(step: DurableStep, command: string | ExecOptions): Promise<ExecResult> {
    const options = normalize(command);
    this.#started = true;
    const result = await step.run(
      async (identity) => {
        const prepared = await this.#prepare();
        return await this.#placement.exec({
          runId: this.#runId,
          step: { id: step.id, ...identity },
          source: prepared,
          command: options,
          secrets: this.#secrets,
        });
      },
      async () => await this.cleanup(),
    );
    if (result.exitCode !== 0) {
      throw new ExecError(step.id, redactSecrets(options.command, this.#secrets), {
        ...result,
        stdout: redactSecrets(result.stdout, this.#secrets),
        stderr: redactSecrets(result.stderr, this.#secrets),
      });
    }
    return result;
  }

  async cleanup(): Promise<void> {
    if (!this.#started || this.#cleaned) return;
    await this.#placement.destroy(this.#runId, this.#secrets);
    this.#cleaned = true;
  }
}

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
