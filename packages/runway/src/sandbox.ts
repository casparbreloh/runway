import { ExecError } from "./exec-error.ts";
import type { ExecOptions, ExecResult } from "./run.ts";
import { redactSecrets } from "./secret-redaction.ts";
import type { PreparedSource, Source } from "./source.ts";

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
    digest: string,
    work: (identity: { readonly count: number; readonly attempt: number }) => Promise<ExecResult>,
    rollback: () => Promise<void>,
  ): Promise<
    | {
        readonly digest: string;
        readonly result: ExecResult;
        readonly callback: "executed" | "recorded";
      }
    | {
        readonly digest: string;
        readonly lost: { readonly message: string; readonly attempt: number };
        readonly callback: "executed" | "recorded";
      }
    | {
        readonly digest: string;
        readonly timeout: { readonly message: string; readonly attempt: number };
        readonly callback: "executed" | "recorded";
      }
  >;
}

export interface Placement {
  exec(request: {
    readonly runId: string;
    readonly step: {
      readonly id: string;
      readonly count: number;
      readonly attempt: number;
    };
    readonly source: PreparedSource;
    readonly command: NormalizedExecOptions;
    readonly secrets: ReadonlyArray<string>;
  }): Promise<ExecResult>;
  destroy(runId: string, secrets: ReadonlyArray<string>): Promise<void>;
}

export class RunLostError extends Error {
  override readonly name = "RunLostError";
}

export class ExecTimeoutError extends Error {
  override readonly name = "ExecTimeoutError";
}

export class Sandbox {
  #cleaned = false;
  #preparation: Promise<PreparedSource> | undefined;
  #lost: RunLostError | undefined;
  #priorStart = false;
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

  #prepare(allowReconstruct: boolean): Promise<PreparedSource> {
    if (this.#preparation) return this.#preparation;
    const preparation = this.#source.prepare({ allowReconstruct });
    this.#preparation = preparation;
    void preparation.catch(() => {
      if (this.#preparation === preparation) this.#preparation = undefined;
    });
    return preparation;
  }

  async exec(step: DurableStep, command: string | ExecOptions): Promise<ExecResult> {
    if (this.#lost) throw this.#lost;
    const options = normalize(command);
    const digest = await digestCommand(options);
    this.#started = true;
    let outcome: Awaited<ReturnType<DurableStep["run"]>>;
    try {
      outcome = await step.run(
        digest,
        async (identity) => {
          if (this.#lost) throw this.#lost;
          let prepared: PreparedSource;
          try {
            prepared = await this.#prepare(!this.#priorStart && identity.attempt === 1);
          } catch (error) {
            if (error instanceof RunLostError) throw this.#lose(error);
            throw error;
          }
          this.#priorStart = true;
          try {
            return await this.#placement.exec({
              runId: this.#runId,
              step: { id: step.id, ...identity },
              source: prepared,
              command: options,
              secrets: this.#secrets,
            });
          } catch (error) {
            if (error instanceof RunLostError) throw this.#lose(error);
            throw error;
          }
        },
        async () => await this.cleanup(),
      );
    } catch (error) {
      if (this.#lost) throw this.#lost;
      throw error;
    }
    if (outcome.digest !== digest) throw this.#lose(new Error("command digest changed"));
    if (outcome.callback === "recorded") this.#priorStart = true;
    if ("lost" in outcome) throw this.#lose(new RunLostError(outcome.lost.message));
    if ("timeout" in outcome) throw new ExecTimeoutError(outcome.timeout.message);
    const result = outcome.result;
    if (result.exitCode !== 0) {
      throw new ExecError(step.id, redactSecrets(options.command, this.#secrets), {
        ...result,
        stdout: redactSecrets(result.stdout, this.#secrets),
        stderr: redactSecrets(result.stderr, this.#secrets),
      });
    }
    return result;
  }

  #lose(error: unknown): RunLostError {
    if (this.#lost) return this.#lost;
    this.#lost =
      error instanceof RunLostError
        ? error
        : new RunLostError("run continuity was lost after command execution may have started");
    return this.#lost;
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

export const digestCommand = async (command: NormalizedExecOptions): Promise<string> => {
  const env = Object.entries(command.env).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const bytes = new TextEncoder().encode(
    JSON.stringify([command.command, command.cwd, env, command.timeoutMs]),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
