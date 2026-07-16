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

export interface RunOperations {
  do<T>(id: string, work: () => Promise<T>): Promise<T>;
  exec(id: string, command: string | ExecOptions): Promise<ExecResult>;
  sleep(id: string, durationMs: number): Promise<void>;
}

export interface Run<Secrets extends string = string> {
  readonly runId: string;
  readonly secrets: { readonly [Name in Secrets]: string };

  do<T>(id: string, work: () => T | Promise<T>): Promise<T>;
  exec(id: string, command: string | ExecOptions): Promise<ExecResult>;
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
  operations: RunOperations,
  meta: {
    runId: string;
    secrets: { readonly [Name in Secrets]: string };
  },
): Run<Secrets> => ({
  runId: meta.runId,
  secrets: meta.secrets,
  do: (id, work) => operations.do(authorId(id), () => Promise.resolve(work())),
  exec: (id, command) => operations.exec(authorId(id), command),
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
