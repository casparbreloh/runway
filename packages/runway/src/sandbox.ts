import { cacheDeclarationEvidence } from "./cache.ts";
import { ExecError } from "./exec-error.ts";
import type { CacheDeclaration, CacheResult, ExecOptions, ExecResult } from "./run.ts";
import { redactSecrets } from "./secret-redaction.ts";
import type { PreparedSource, Source } from "./source.ts";
import type { Finalization, Terminal } from "./terminal.ts";

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

export interface DurableCache {
  readonly id: string;
  run(
    digest: string,
    work: () => Promise<CacheResult>,
  ): Promise<{ readonly digest: string; readonly result: CacheResult }>;
}

export interface Placement {
  cache?(request: {
    readonly runId: string;
    readonly id: string;
    readonly declaration: CacheDeclaration;
    readonly source: PreparedSource;
    readonly secrets: ReadonlyArray<string>;
  }): Promise<CacheResult>;
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
  readonly #cacheDeclarations = new Map<
    string,
    { readonly digest: string; readonly target: string }
  >();
  #cleaned = false;
  #cleaning: Promise<void> | undefined;
  #preparation: Promise<PreparedSource> | undefined;
  #lost: RunLostError | undefined;
  #priorStart = false;
  #started = false;
  #used = false;
  readonly #placement: Placement;
  readonly #runId: string;
  readonly #secrets: ReadonlyArray<string>;
  readonly #source: Source;
  readonly #terminal: Pick<Terminal, "verify">;

  constructor(options: {
    readonly runId: string;
    readonly secrets: Readonly<Record<string, string>>;
    readonly source: Source;
    readonly placement: Placement;
    readonly terminal: Pick<Terminal, "verify">;
  }) {
    this.#runId = options.runId;
    this.#secrets = Object.values(options.secrets);
    this.#source = options.source;
    this.#placement = options.placement;
    this.#terminal = options.terminal;
  }

  async cache(step: DurableCache, declaration: CacheDeclaration): Promise<CacheResult> {
    if (this.#started) throw new Error("cache restore must be declared before command execution");
    const evidence = await cacheDeclarationEvidence(declaration);
    const previous = this.#cacheDeclarations.get(step.id);
    if (previous && previous.digest !== evidence.digest) {
      throw new Error(`cache declaration collision for ${step.id}`);
    }
    for (const [id, candidate] of this.#cacheDeclarations) {
      if (
        id !== step.id &&
        (candidate.target === evidence.target ||
          candidate.target.startsWith(`${evidence.target}/`) ||
          evidence.target.startsWith(`${candidate.target}/`))
      ) {
        throw new Error(`cache target overlaps ${id}`);
      }
    }
    this.#cacheDeclarations.set(step.id, evidence);
    const digest = evidence.digest;
    if (this.#placement.cache) this.#used = true;
    const outcome = await step.run(digest, async () => {
      if (!this.#placement.cache) return { state: "miss", reason: "unavailable" };
      const prepared = await this.#prepare(true);
      return await this.#placement.cache({
        runId: this.#runId,
        id: step.id,
        declaration: { ...declaration, path: evidence.target },
        source: prepared,
        secrets: this.#secrets,
      });
    });
    if (outcome.digest !== digest) {
      throw new Error("cache declaration changed across durable retry");
    }
    return cacheResult(outcome.result);
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
    this.#used = true;
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
    if (!this.#used || this.#cleaned) return;
    if (this.#cleaning) return await this.#cleaning;
    const cleaning = (async () => {
      await this.#placement.destroy(this.#runId, this.#secrets);
      this.#cleaned = true;
    })();
    this.#cleaning = cleaning;
    try {
      await cleaning;
    } finally {
      if (!this.#cleaned && this.#cleaning === cleaning) this.#cleaning = undefined;
    }
  }

  async finish(finalization: Finalization): Promise<void> {
    await this.#terminal.verify(finalization);
    await this.cleanup();
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

const cacheResult = (value: unknown): CacheResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid durable cache result");
  }
  const result = value as Record<string, unknown>;
  if (
    result.state === "hit" &&
    Object.keys(result).sort().join(",") === "bytes,state" &&
    Number.isSafeInteger(result.bytes) &&
    (result.bytes as number) >= 0
  ) {
    return { state: "hit", bytes: result.bytes as number };
  }
  if (
    (result.state === "miss" || result.state === "skipped") &&
    Object.keys(result).sort().join(",") === "reason,state" &&
    ["absent", "budget", "corrupt", "unavailable", "policy", "target"].includes(
      result.reason as string,
    )
  ) {
    return result as CacheResult;
  }
  throw new Error("invalid durable cache result");
};
