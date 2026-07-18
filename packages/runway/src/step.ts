export interface ExecOptions {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

const trustedExecErrors = new WeakSet<ExecError>();

export class ExecError extends Error {
  override readonly name = "ExecError";
  readonly id: string;
  readonly command: string;
  readonly result: ExecResult;

  constructor(id: string, command: string, result: ExecResult) {
    super(`command ${JSON.stringify(id)} exited with code ${result.exitCode}: ${command}`);
    this.id = id;
    this.command = command;
    this.result = result;
  }
}

export const trustedExecError = (id: string, command: string, result: ExecResult): ExecError => {
  const error = new ExecError(id, command, result);
  trustedExecErrors.add(error);
  return error;
};

export const isTrustedExecError = (error: unknown): error is ExecError =>
  error instanceof ExecError && trustedExecErrors.has(error);

export type CacheKey =
  | string
  | {
      readonly prefix?: string;
      readonly files: readonly [string, ...string[]];
    };

export interface CacheDeclaration {
  readonly key: CacheKey;
  readonly paths: readonly [string, ...string[]];
  readonly restoreKeys?: readonly string[];
}

export type CacheResult =
  | {
      readonly state: "hit";
      readonly bytes: number;
      readonly key: string;
      readonly match: "exact" | "restore";
    }
  | {
      readonly state: "miss" | "skipped";
      readonly reason: "absent" | "budget" | "corrupt" | "unavailable" | "policy" | "target";
    };

export const validateCacheDeclaration = (declaration: CacheDeclaration): void => {
  if (!Array.isArray(declaration.paths) || declaration.paths.length === 0) {
    throw new Error("cache paths must not be empty");
  }
};

export interface Step<Secrets extends string = string> {
  readonly runId: string;
  readonly secrets: { readonly [Name in Secrets]: string };

  do<T>(id: string, work: () => T | Promise<T>): Promise<T>;
  exec(id: string, command: string | ExecOptions): Promise<ExecResult>;
  cache(id: string, declaration: CacheDeclaration): Promise<CacheResult>;
  sleep(id: string, durationMs: number): Promise<void>;
}

const authorId = (id: string): string => {
  const bytes = new TextEncoder().encode(id).byteLength;
  if (bytes < 1 || bytes > 128) {
    throw new Error("operation id must contain between 1 and 128 UTF-8 bytes");
  }
  if (id.startsWith("runway:")) {
    throw new Error(`operation id ${JSON.stringify(id)} is reserved by Runway`);
  }
  return id;
};

export const makeStep = <Secrets extends string>(
  operations: Pick<Step, "do" | "exec" | "cache" | "sleep">,
  meta: {
    runId: string;
    secrets: { readonly [Name in Secrets]: string };
  },
): Step<Secrets> => ({
  runId: meta.runId,
  secrets: meta.secrets,
  do: (id, work) => operations.do(authorId(id), () => Promise.resolve(work())),
  exec: (id, command) => operations.exec(authorId(id), command),
  cache: (id, declaration) => {
    validateCacheDeclaration(declaration);
    return operations.cache(authorId(id), declaration);
  },
  sleep: (id, durationMs) => operations.sleep(authorId(id), durationMs),
});

export const secretsOf = (
  names: ReadonlyArray<string>,
  source: unknown,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    names.map((name): [string, string] => {
      const value = (source as Record<string, unknown>)[name];
      if (typeof value !== "string") throw new Error(`missing secret: ${name}`);
      return [name, value];
    }),
  );
