import { trustedExecError, validateCacheDeclaration } from "../../step.ts";
import type { CacheDeclaration, CacheResult, ExecOptions, ExecResult } from "../../step.ts";
import { cacheDeclarationEvidence } from "../cache/cache.ts";
import type { CacheTreeDeclaration, PendingCache, PreparedCache } from "../cache/cache.ts";
import { normalizedCacheTarget } from "../cache/path.ts";
import type { Meter } from "../meter.ts";
import { redactSecrets } from "../secret/redaction.ts";
import type { PreparedSource, Source } from "../source/source.ts";
import type { Finalization, Terminal } from "../terminal.ts";

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
    work: () => Promise<CacheRecord>,
  ): Promise<{ readonly digest: string; readonly record: CacheRecord }>;
}

export interface CacheRecord {
  readonly result: CacheResult;
  readonly pending?: PendingCache;
}

export interface DurableCachePublication {
  run(work: () => Promise<void>): Promise<void>;
}

export interface Placement {
  cache?(request: {
    readonly runId: string;
    readonly id: string;
    readonly declaration: CacheTreeDeclaration;
    readonly source: PreparedSource;
    readonly secrets: ReadonlyArray<string>;
  }): Promise<CacheRecord>;
  discardCaches?(request: {
    readonly runId: string;
    readonly paths: readonly string[];
    readonly secrets: ReadonlyArray<string>;
  }): Promise<void>;
  quiesce?(runId: string, secrets: ReadonlyArray<string>): Promise<void>;
  prepareCaches?(request: {
    readonly runId: string;
    readonly pending: readonly PendingCache[];
    readonly secrets: ReadonlyArray<string>;
  }): Promise<readonly PreparedCache[]>;
  publishCaches?(request: {
    readonly runId: string;
    readonly finalization: Finalization;
    readonly prepared: readonly PreparedCache[];
    readonly secrets: ReadonlyArray<string>;
  }): Promise<void>;
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
  readonly #pendingCaches = new Map<string, PendingCache>();
  #prepared: Promise<readonly PreparedCache[]> | undefined;
  #cleaned = false;
  #cleaning: Promise<void> | undefined;
  #preparation: Promise<PreparedSource> | undefined;
  #lost: RunLostError | undefined;
  #priorStart = false;
  #started = false;
  readonly #startedCommands = new Set<string>();
  #used = false;
  readonly #meter: Meter | undefined;
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
    readonly meter?: Meter;
  }) {
    this.#runId = options.runId;
    this.#secrets = Object.values(options.secrets);
    this.#source = options.source;
    this.#placement = options.placement;
    this.#terminal = options.terminal;
    this.#meter = options.meter;
  }

  async cache(step: DurableCache, declaration: CacheTreeDeclaration): Promise<CacheResult> {
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
    const started = this.#meter?.now();
    const outcome = await step.run(digest, async () => {
      if (!this.#placement.cache) return { result: { state: "miss", reason: "unavailable" } };
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
    const record = cacheRecord(outcome.record);
    if (record.pending) this.#pendingCaches.set(step.id, record.pending);
    else this.#pendingCaches.delete(step.id);
    this.#observe(() =>
      this.#meter?.record({
        type: "cache",
        state: record.result.state,
        durationMs: this.#elapsed(started),
        bytes: record.result.state === "hit" ? record.result.bytes : 0,
      }),
    );
    return record.result;
  }

  async cacheSet(
    id: string,
    declaration: CacheDeclaration,
    durable: (id: string) => DurableCache,
  ): Promise<CacheResult> {
    validateCacheDeclaration(declaration);
    const results = [];
    for (const [index, path] of declaration.paths.entries()) {
      const treeId = declaration.paths.length === 1 ? id : await cacheTreeId(id, index, path);
      results.push({
        path,
        result: await this.cache(durable(treeId), {
          key: declaration.key,
          path,
          ...(declaration.restoreKeys ? { restoreKeys: declaration.restoreKeys } : {}),
        }),
      });
    }
    const hits = results.filter(
      (
        entry,
      ): entry is typeof entry & {
        result: Extract<(typeof entry)["result"], { state: "hit" }>;
      } => entry.result.state === "hit",
    );
    if (hits.length > 0 && hits.length !== results.length) {
      await this.#discardCaches(hits.map((entry) => entry.path));
    }
    const miss = results.find((entry) => entry.result.state !== "hit")?.result;
    if (miss) return miss;
    const first = hits[0]!.result;
    if (hits.some((entry) => entry.result.key !== first.key)) {
      await this.#discardCaches(hits.map((entry) => entry.path));
      return { state: "miss", reason: "absent" };
    }
    if (hits.length === 1 && hits[0]!.result.match === "exact") {
      this.#pendingCaches.delete(id);
    }
    return {
      state: "hit",
      bytes: hits.reduce((total, entry) => total + entry.result.bytes, 0),
      key: first.key,
      match: hits.some((entry) => entry.result.match === "restore") ? "restore" : "exact",
    };
  }

  async #discardCaches(paths: readonly string[]): Promise<void> {
    if (!this.#placement.discardCaches) {
      throw new Error("cache placement cannot discard an incomplete cache set");
    }
    await this.#placement.discardCaches({
      runId: this.#runId,
      paths: paths.map(normalizedCacheTarget),
      secrets: this.#secrets,
    });
  }

  async prepare(): Promise<readonly PreparedCache[]> {
    if (this.#prepared) return await this.#prepared;
    const preparing = (async () => {
      if (this.#pendingCaches.size === 0) return [];
      if (this.#placement.quiesce) {
        await this.#placement.quiesce(this.#runId, this.#secrets);
      }
      if (!this.#placement.prepareCaches || this.#pendingCaches.size === 0) return [];
      return await this.#placement.prepareCaches({
        runId: this.#runId,
        pending: [...this.#pendingCaches.values()],
        secrets: this.#secrets,
      });
    })();
    this.#prepared = preparing;
    try {
      return await preparing;
    } catch (error) {
      if (this.#prepared === preparing) this.#prepared = undefined;
      throw error;
    }
  }

  hasPendingCaches(): boolean {
    return this.#pendingCaches.size > 0;
  }

  #prepare(allowReconstruct: boolean): Promise<PreparedSource> {
    if (this.#preparation) return this.#preparation;
    const started = this.#meter?.now();
    let durationMs: number | undefined;
    const preparation = this.#source
      .prepare({ allowReconstruct })
      .then((prepared) => {
        const observedDuration = this.#elapsed(started);
        durationMs = observedDuration;
        this.#observe(() =>
          this.#meter?.record({
            type: "source",
            state: prepared.result.state,
            durationMs: observedDuration,
            bytes: prepared.result.bytes,
          }),
        );
        this.#observe(() =>
          this.#meter?.record({
            type: "sandbox",
            phase: "ready",
            durationMs: observedDuration,
          }),
        );
        return prepared;
      })
      .finally(() => {
        this.#observe(() => this.#meter?.allocation(durationMs ?? this.#elapsed(started)));
      });
    this.#preparation = preparation;
    void preparation.catch(() => {
      if (this.#preparation === preparation) this.#preparation = undefined;
    });
    return preparation;
  }

  async exec(step: DurableStep, command: string | ExecOptions): Promise<ExecResult> {
    if (this.#lost) throw this.#lost;
    const options = normalizeExec(command);
    const digest = await digestCommand(options);
    this.#started = true;
    this.#used = true;
    let outcome: Awaited<ReturnType<DurableStep["run"]>>;
    const started = this.#meter?.now();
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
          this.#startedCommands.add(step.id);
          const allocationStarted = this.#meter?.now();
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
          } finally {
            this.#observe(() => this.#meter?.allocation(this.#elapsed(allocationStarted)));
          }
        },
        async () => await this.cleanup(),
      );
    } catch (error) {
      if (this.#lost) throw this.#lost;
      throw error;
    }
    if (outcome.digest !== digest) throw this.#lose(new Error("command digest changed"));
    if (outcome.callback === "recorded") {
      this.#priorStart = true;
      this.#startedCommands.add(step.id);
    }
    if ("lost" in outcome) {
      throw this.#lose(new RunLostError(outcome.lost.message));
    }
    if ("timeout" in outcome) throw new ExecTimeoutError(outcome.timeout.message);
    const result = outcome.result;
    this.#observe(() =>
      this.#meter?.record({
        type: "exec",
        state: outcome.callback === "recorded" ? "reconnected" : "finished",
        durationMs: outcome.callback === "recorded" ? this.#elapsed(started) : result.durationMs,
      }),
    );
    if (result.exitCode !== 0) {
      throw trustedExecError(step.id, redactSecrets(options.command, this.#secrets), {
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
    this.#observe(() =>
      this.#meter?.record({ type: "loss", startedCommands: this.#startedCommands.size }),
    );
    return this.#lost;
  }

  async cleanup(): Promise<void> {
    if (!this.#used || this.#cleaned) return;
    if (this.#cleaning) return await this.#cleaning;
    const cleaning = (async () => {
      const started = this.#meter?.now();
      try {
        await this.#placement.destroy(this.#runId, this.#secrets);
        this.#cleaned = true;
      } finally {
        const durationMs = this.#elapsed(started);
        this.#observe(() =>
          this.#meter?.record({
            type: "sandbox",
            phase: "destroy",
            durationMs,
          }),
        );
        this.#observe(() => this.#meter?.allocation(durationMs));
      }
    })();
    this.#cleaning = cleaning;
    try {
      await cleaning;
    } finally {
      if (!this.#cleaned && this.#cleaning === cleaning) this.#cleaning = undefined;
    }
  }

  async finish(
    finalization: Finalization,
    prepared: readonly PreparedCache[] = [],
    publication?: DurableCachePublication,
  ): Promise<void> {
    await this.#terminal.verify(finalization);
    if (
      finalization.outcome === "success" &&
      prepared.some((entry) => entry.state === "ready") &&
      this.#placement.publishCaches
    ) {
      const publish = async (): Promise<void> =>
        await this.#placement.publishCaches!({
          runId: this.#runId,
          finalization,
          prepared,
          secrets: this.#secrets,
        });
      await (publication ? publication.run(publish) : publish()).catch(() => {});
    }
    await this.cleanup();
  }

  #elapsed(started: number | undefined): number {
    return started === undefined ? 0 : Math.max(0, Math.round(this.#meter!.now() - started));
  }

  #observe(work: () => void): void {
    try {
      work();
    } catch {}
  }
}

export const normalizeExec = (command: string | ExecOptions): NormalizedExecOptions => {
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

const cacheTreeId = async (id: string, index: number, path: string): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify([id, index, path]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `runway:cache-tree:${hex}`;
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
    Object.keys(result).sort().join(",") === "bytes,key,match,state" &&
    Number.isSafeInteger(result.bytes) &&
    (result.bytes as number) >= 0 &&
    typeof result.key === "string" &&
    (result.match === "exact" || result.match === "restore")
  ) {
    return result as unknown as CacheResult;
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

const cacheRecord = (value: unknown): CacheRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid durable cache record");
  }
  const record = value as Record<string, unknown>;
  if (!["result", "pending,result"].includes(Object.keys(record).sort().join(","))) {
    throw new Error("invalid durable cache record");
  }
  const result = cacheResult(record.result);
  if (record.pending === undefined) return { result };
  if (!record.pending || typeof record.pending !== "object" || Array.isArray(record.pending)) {
    throw new Error("invalid durable cache record");
  }
  return { result, pending: structuredClone(record.pending) as PendingCache };
};
