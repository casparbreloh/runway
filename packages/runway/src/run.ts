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

export interface Budget {
  readonly maxBytes: number;
  readonly maxDurationMs: number;
  readonly maxEstimatedCostUsd: number;
}

export type CacheKey =
  | string
  | {
      readonly files: readonly [string, ...string[]];
      readonly salt?: string;
    };

export interface CacheDeclaration {
  readonly key: CacheKey;
  readonly path: string;
  readonly budget?: Partial<Budget>;
}

export type CacheResult =
  | { readonly state: "hit"; readonly bytes: number }
  | {
      readonly state: "miss" | "skipped";
      readonly reason: "absent" | "budget" | "corrupt" | "unavailable" | "policy" | "target";
    };

export interface Run<Secrets extends string = string> {
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

export const makeRun = <Secrets extends string>(
  operations: Pick<Run, "do" | "exec" | "cache" | "sleep">,
  meta: {
    runId: string;
    secrets: { readonly [Name in Secrets]: string };
  },
): Run<Secrets> => ({
  runId: meta.runId,
  secrets: meta.secrets,
  do: (id, work) => operations.do(authorId(id), () => Promise.resolve(work())),
  exec: (id, command) => operations.exec(authorId(id), command),
  cache: (id, declaration) => {
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
