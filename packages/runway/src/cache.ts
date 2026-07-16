const encoder = new TextEncoder();

type CacheKey = string | { readonly files: readonly string[]; readonly salt?: string };

interface CacheDeclaration {
  readonly key: CacheKey;
  readonly path: string;
}

interface CacheContext {
  readonly repositoryId: string;
  readonly workflowId: string;
  readonly generation: number;
  readonly admission: {
    readonly type: string;
    readonly ref?: string;
    readonly defaultRef?: string;
    readonly number?: number;
    readonly headRepositoryId?: string;
  };
  readonly platform: {
    readonly schema: number;
    readonly os: string;
    readonly architecture: string;
    readonly imageDigest: string;
    readonly runnerAbi: string;
  };
}

interface CacheFiles {
  inspect(
    path: string,
  ): Promise<
    | { readonly type: "file"; readonly bytes: Uint8Array }
    | { readonly type: "missing" }
    | { readonly type: "symlink" }
    | { readonly type: "directory" }
  >;
}

interface CacheRefs {
  get(key: string): Promise<{ readonly etag: string; readonly text: () => Promise<string> } | null>;
  put(
    key: string,
    text: string,
    options: {
      readonly onlyIf: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string };
    },
  ): Promise<{ readonly etag: string } | null>;
}

interface CacheOptions {
  readonly context: CacheContext;
  readonly files: CacheFiles;
  readonly refs: CacheRefs;
  readonly current: () => Promise<boolean>;
}

const bytes = (value: string | Uint8Array): Uint8Array =>
  typeof value === "string" ? encoder.encode(value) : value;

const canonical = (fields: readonly (string | Uint8Array)[]): Uint8Array => {
  const chunks = fields.map(bytes);
  const size = chunks.reduce((total, chunk) => total + 8 + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const chunk of chunks) {
    view.setBigUint64(offset, BigInt(chunk.byteLength));
    offset += 8;
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
};

const digest = async (fields: readonly (string | Uint8Array)[]): Promise<string> => {
  const value = await crypto.subtle.digest("SHA-256", canonical(fields));
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

class CacheError extends Error {
  override readonly name = "CacheError";
}

const byteLength = (value: string): number => encoder.encode(value).byteLength;

const validText = (value: string, min: number, max: number): boolean => {
  const length = byteLength(value);
  if (length < min || length > max) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
};

const invalid = (): never => {
  throw new CacheError("invalid cache declaration");
};

const validateId = (id: string): void => {
  if (!validText(id, 1, 128) || id.startsWith("runway:")) invalid();
};

const validateFilePaths = (paths: readonly string[]): void => {
  if (paths.length < 1 || paths.length > 64) invalid();
  let previous: string | undefined;
  for (const path of paths) {
    if (
      !validText(path, 1, 512) ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      (previous !== undefined && previous >= path)
    ) {
      invalid();
    }
    previous = path;
  }
};

const validateKeyDefinition = (key: CacheKey): void => {
  if (typeof key === "string") {
    if (!validText(key, 1, 512)) invalid();
    return;
  }
  validateFilePaths(key.files);
  if (key.salt !== undefined && !validText(key.salt, 0, 512)) invalid();
};

const normalizedTarget = (target: string): string => {
  const parts = (target.startsWith("/") ? target : `/workspace/${target}`).split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return `/${normalized.join("/")}`;
};

const keyDefinition = (key: CacheKey): Array<string> =>
  typeof key === "string"
    ? ["string", key]
    : ["files", key.salt ?? "", String(key.files.length), ...key.files];

const SHA256 = /^[0-9a-f]{64}$/;

interface CacheRef {
  readonly cacheIdDigest: string;
  readonly declarationDigest: string;
  readonly generation: number;
  readonly keyDigest: string;
  readonly objectDigest: string;
  readonly platformDigest: string;
  readonly repositoryDigest: string;
  readonly schema: number;
  readonly scopeDigest: string;
}

interface CacheRevision extends Omit<CacheRef, "objectDigest"> {
  readonly ref: string;
  readonly etag: string | null;
}

const canonicalRef = (ref: CacheRef): string =>
  JSON.stringify({
    cacheIdDigest: ref.cacheIdDigest,
    declarationDigest: ref.declarationDigest,
    generation: ref.generation,
    keyDigest: ref.keyDigest,
    objectDigest: ref.objectDigest,
    platformDigest: ref.platformDigest,
    repositoryDigest: ref.repositoryDigest,
    schema: ref.schema,
    scopeDigest: ref.scopeDigest,
  });

const parseRef = (text: string): CacheRef => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CacheError("invalid cache ref");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CacheError("invalid cache ref");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "cacheIdDigest,declarationDigest,generation,keyDigest,objectDigest,platformDigest,repositoryDigest,schema,scopeDigest" ||
    typeof record.cacheIdDigest !== "string" ||
    typeof record.declarationDigest !== "string" ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    typeof record.keyDigest !== "string" ||
    typeof record.objectDigest !== "string" ||
    typeof record.platformDigest !== "string" ||
    typeof record.repositoryDigest !== "string" ||
    !Number.isSafeInteger(record.schema) ||
    typeof record.scopeDigest !== "string" ||
    ![
      record.cacheIdDigest,
      record.declarationDigest,
      record.keyDigest,
      record.objectDigest,
      record.platformDigest,
      record.repositoryDigest,
      record.scopeDigest,
    ].every((field) => SHA256.test(field as string))
  ) {
    throw new CacheError("invalid cache ref");
  }
  const ref = record as unknown as CacheRef;
  if (canonicalRef(ref) !== text) throw new CacheError("invalid cache ref");
  return ref;
};

const assertRefIdentity = (
  ref: CacheRef,
  expected: Omit<CacheRef, "generation" | "objectDigest">,
): void => {
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (ref[key] !== expected[key]) throw new CacheError("cache ref identity mismatch");
  }
};

const scopes = (
  context: CacheContext,
): { readonly write: string; readonly reads: readonly string[] } | { readonly policy: "skip" } => {
  const admission = context.admission;
  if (admission.type === "push" && admission.ref && admission.defaultRef) {
    const trusted = `default:${admission.defaultRef}`;
    if (admission.ref === admission.defaultRef) return { write: trusted, reads: [trusted] };
    const own = `branch:${admission.ref}`;
    return { write: own, reads: [own, trusted] };
  }
  if (
    admission.type === "pull_request" &&
    Number.isSafeInteger(admission.number) &&
    admission.number !== undefined &&
    admission.number > 0 &&
    admission.headRepositoryId &&
    admission.defaultRef
  ) {
    if (admission.headRepositoryId !== context.repositoryId) return { policy: "skip" };
    const own = `pull-request:${admission.number}`;
    return { write: own, reads: [own, `default:${admission.defaultRef}`] };
  }
  if (admission.type === "webhook" || admission.type === "cron") {
    const own = `workflow:${context.workflowId}`;
    return { write: own, reads: [own] };
  }
  throw new CacheError("invalid cache trust context");
};

const keyDigest = async (key: CacheKey, files: CacheFiles): Promise<string> => {
  validateKeyDefinition(key);
  if (typeof key === "string") return digest(["string", key]);
  const fields: Array<string | Uint8Array> = ["files", key.salt ?? "", String(key.files.length)];
  for (const path of key.files) {
    const entry = await files.inspect(path);
    if (entry.type !== "file" && entry.type !== "missing") invalid();
    fields.push(path, entry.type);
    if (entry.type === "file") fields.push(entry.bytes);
  }
  return digest(fields);
};

export class Cache {
  readonly #context: CacheContext;
  readonly #current: () => Promise<boolean>;
  readonly #declarations = new Map<
    string,
    {
      readonly cacheIdDigest?: string;
      readonly declarationDigest: string;
      readonly keyDigest?: string;
    }
  >();
  readonly #files: CacheFiles;
  readonly #refs: CacheRefs;

  constructor(options: CacheOptions) {
    this.#context = options.context;
    this.#current = options.current;
    this.#files = options.files;
    this.#refs = options.refs;
  }

  async lookup(id: string, declaration: CacheDeclaration) {
    validateId(id);
    validateKeyDefinition(declaration.key);
    const scopePlan = scopes(this.#context);
    if ("policy" in scopePlan) {
      return { state: "skipped" as const, reason: "policy" as const, revision: null };
    }
    const target = normalizedTarget(declaration.path);
    const declarationDigest = await digest([
      "declaration",
      id,
      target,
      ...keyDefinition(declaration.key),
      String(this.#context.platform.schema),
    ]);
    const previous = this.#declarations.get(id);
    if (previous !== undefined && previous.declarationDigest !== declarationDigest) {
      throw new CacheError(`cache declaration collision for ${id}`);
    }
    const reservation = previous ?? { declarationDigest };
    if (!previous) this.#declarations.set(id, reservation);
    let key: string;
    try {
      key = await keyDigest(declaration.key, this.#files);
    } catch (error) {
      if (this.#declarations.get(id) === reservation && !reservation.keyDigest) {
        this.#declarations.delete(id);
      }
      throw error;
    }
    const [repository, cacheId, platform] = await Promise.all([
      digest(["repository", this.#context.repositoryId]),
      digest(["cache-id", id]),
      digest([
        "platform",
        String(this.#context.platform.schema),
        this.#context.platform.os,
        this.#context.platform.architecture,
        this.#context.platform.imageDigest,
        this.#context.platform.runnerAbi,
      ]),
    ]);
    this.#declarations.set(id, { cacheIdDigest: cacheId, declarationDigest, keyDigest: key });
    const refs = await Promise.all(
      scopePlan.reads.map(async (scope) => {
        const scopeDigest = await digest(["scope", this.#context.repositoryId, scope]);
        return {
          ref: `refs/${repository}/${scopeDigest}/${cacheId}/${key}/${platform}.json`,
          identity: {
            cacheIdDigest: cacheId,
            declarationDigest,
            keyDigest: key,
            platformDigest: platform,
            repositoryDigest: repository,
            schema: this.#context.platform.schema,
            scopeDigest,
          },
        };
      }),
    );
    let writeEtag: string | null = null;
    for (const [index, candidate] of refs.entries()) {
      const observed = await this.#refs.get(candidate.ref);
      if (index === 0) writeEtag = observed?.etag ?? null;
      if (!observed) continue;
      const stored = parseRef(await observed.text());
      assertRefIdentity(stored, candidate.identity);
      return {
        state: "hit" as const,
        object: { digest: stored.objectDigest },
        revision: {
          ...refs[0]!.identity,
          ref: refs[0]!.ref,
          etag: writeEtag,
          generation: this.#context.generation,
        },
        source: { ref: candidate.ref, etag: observed.etag },
      };
    }
    return {
      state: "miss" as const,
      revision: {
        ...refs[0]!.identity,
        ref: refs[0]!.ref,
        etag: writeEtag,
        generation: this.#context.generation,
      },
    };
  }

  async publish(revision: CacheRevision, object: { readonly digest: string }) {
    if (!revision || !object || !SHA256.test(object.digest)) {
      throw new CacheError("invalid cache publication");
    }
    const declaration = [...this.#declarations.values()].find(
      (candidate) =>
        candidate.cacheIdDigest !== undefined &&
        candidate.keyDigest !== undefined &&
        candidate.cacheIdDigest === revision.cacheIdDigest &&
        candidate.declarationDigest === revision.declarationDigest &&
        candidate.keyDigest === revision.keyDigest,
    );
    if (!declaration) throw new CacheError("blind cache publication");
    const scopePlan = scopes(this.#context);
    if ("policy" in scopePlan) throw new CacheError("cache publication denied by policy");
    const [repositoryDigest, scopeDigest, platformDigest] = await Promise.all([
      digest(["repository", this.#context.repositoryId]),
      digest(["scope", this.#context.repositoryId, scopePlan.write]),
      digest([
        "platform",
        String(this.#context.platform.schema),
        this.#context.platform.os,
        this.#context.platform.architecture,
        this.#context.platform.imageDigest,
        this.#context.platform.runnerAbi,
      ]),
    ]);
    const expected = {
      cacheIdDigest: revision.cacheIdDigest,
      declarationDigest: revision.declarationDigest,
      keyDigest: revision.keyDigest,
      platformDigest,
      repositoryDigest,
      schema: this.#context.platform.schema,
      scopeDigest,
    };
    const expectedRef = `refs/${repositoryDigest}/${scopeDigest}/${revision.cacheIdDigest}/${revision.keyDigest}/${platformDigest}.json`;
    if (
      revision.ref !== expectedRef ||
      revision.generation !== this.#context.generation ||
      Object.entries(expected).some(
        ([key, value]) => revision[key as keyof typeof expected] !== value,
      )
    ) {
      throw new CacheError("cache publication identity mismatch");
    }
    if (!(await this.#current())) throw new CacheError("cache publication superseded");
    const ref: CacheRef = {
      ...expected,
      generation: revision.generation,
      objectDigest: object.digest,
    };
    let onlyIf =
      revision.etag === null ? { etagDoesNotMatch: "*" } : { etagMatches: revision.etag };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const stored = await this.#refs.put(revision.ref, canonicalRef(ref), { onlyIf });
      if (stored) return { state: "published" as const };
      const winner = await this.#refs.get(revision.ref);
      if (!winner) throw new CacheError("cache publication stale");
      const winnerRef = parseRef(await winner.text());
      assertRefIdentity(winnerRef, expected);
      if (winnerRef.generation > revision.generation) {
        throw new CacheError("cache publication superseded");
      }
      if (winnerRef.generation === revision.generation) {
        if (winnerRef.objectDigest === object.digest) return { state: "duplicate" as const };
        throw new CacheError("cache publication stale");
      }
      if (!(await this.#current())) throw new CacheError("cache publication superseded");
      onlyIf = { etagMatches: winner.etag };
    }
    throw new CacheError("cache publication stale");
  }
}
