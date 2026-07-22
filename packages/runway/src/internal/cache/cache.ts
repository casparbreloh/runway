const encoder = new TextEncoder();

import type { CacheDeclaration, CacheKey } from "../../step.ts";
import type { Meter } from "../meter.ts";
import { normalizedCacheTarget } from "./path.ts";

export interface Budget {
  readonly maxBytes: number;
  readonly maxDurationMs: number;
}

export interface CacheTreeDeclaration extends Omit<CacheDeclaration, "paths"> {
  readonly path: string;
  readonly budget?: Partial<Budget>;
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
    readonly imageDigest?: string;
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
  list(prefix: string): Promise<{
    readonly candidates: readonly { readonly key: string; readonly uploadedAtMs: number }[];
    readonly truncated: boolean;
  }>;
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
  readonly restore?: CacheRestore;
  readonly snapshots?: CacheSnapshots;
  readonly diagnose?: (diagnostic: CacheDiagnostic) => void;
  readonly meter?: Meter;
}

interface CacheRestore {
  inspect(path: string): Promise<"absent" | "empty" | "nonempty">;
  stage(request: {
    readonly object: {
      readonly digest: string;
      readonly archiveBytes: number;
      readonly archiveDigest: string;
      readonly byteCount: number;
      readonly entryCount: number;
      readonly fileCount: number;
      readonly manifest: string;
      readonly maxDepth: number;
      readonly treeDigest: string;
      readonly uniqueInodes: number;
    };
    readonly path: string;
    readonly target: string;
    readonly budget: CacheTreeDeclaration["budget"];
  }): Promise<
    | {
        readonly state: "ready";
        readonly archiveBytes: number;
        readonly archiveDigest: string;
        readonly byteCount: number;
        readonly diskBytes: number;
        readonly entryCount: number;
        readonly fileCount: number;
        readonly maxDepth: number;
        readonly treeDigest: string;
        readonly uniqueInodes: number;
      }
    | {
        readonly state: "miss";
        readonly reason: "absent" | "budget" | "corrupt" | "unavailable";
      }
  >;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

interface SnapshotArchive {
  readonly path: string;
  readonly bytes: number;
  readonly digest: string;
}

interface SnapshotCapture {
  readonly state: "ready";
  readonly archive: SnapshotArchive;
  readonly entryCount: number;
  readonly uniqueInodes: number;
  readonly fileCount: number;
  readonly byteCount: number;
  readonly diskBytes: number;
  readonly maxDepth: number;
  readonly treeDigest: string;
  readonly durationMs: number;
}

interface CacheSnapshots {
  inspect(path: string): Promise<"absent" | "empty" | "nonempty">;
  capture(request: {
    readonly target: string;
    readonly path: string;
    readonly budget: CacheTreeDeclaration["budget"];
  }): Promise<
    | SnapshotCapture
    | {
        readonly state: "skipped";
        readonly reason: "unsafe" | "corrupt" | "unavailable" | "budget";
      }
  >;
  upload(request: {
    readonly key: string;
    readonly path: string;
    readonly expected: SnapshotArchive;
  }): Promise<{ readonly state: "stored" | "present" } & SnapshotArchive>;
  remove(path: string): Promise<void>;
}

interface CacheDiagnostic {
  readonly id: string;
  readonly state: "saved" | "skipped";
  readonly reason?: "unsafe" | "corrupt" | "unavailable" | "budget" | "conflict";
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
  if (!validText(id, 1, 128)) invalid();
};

const validateFilePaths = (paths: readonly string[]): void => {
  if (paths.length < 1 || paths.length > 64) invalid();
  const unique = new Set<string>();
  for (const path of paths) {
    if (
      !validText(path, 1, 512) ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      unique.has(path)
    ) {
      invalid();
    }
    unique.add(path);
  }
};

const validateKeyDefinition = (key: CacheKey): void => {
  if (typeof key === "string") {
    if (!validText(key, 1, 512)) invalid();
    return;
  }
  validateFilePaths(key.files);
  if (key.prefix !== undefined && !validText(key.prefix, 0, 512)) invalid();
};

const keyDefinition = (key: CacheKey): Array<string> =>
  typeof key === "string"
    ? ["string", key]
    : ["files", key.prefix ?? "", String(key.files.length), ...key.files.toSorted()];

export const cacheDeclarationEvidence = async (
  declaration: CacheTreeDeclaration,
): Promise<{ readonly digest: string; readonly target: string }> => {
  validateKeyDefinition(declaration.key);
  for (const restoreKey of declaration.restoreKeys ?? []) {
    if (!validText(restoreKey, 1, 512)) invalid();
  }
  const target = normalizedCacheTarget(declaration.path);
  const budget = declaration.budget;
  if (budget !== undefined) {
    if (
      !budget ||
      typeof budget !== "object" ||
      !["", "maxBytes", "maxDurationMs", "maxBytes,maxDurationMs"].includes(
        Object.keys(budget).sort().join(","),
      ) ||
      (budget.maxBytes !== undefined &&
        (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 0)) ||
      (budget.maxDurationMs !== undefined &&
        (!Number.isSafeInteger(budget.maxDurationMs) || budget.maxDurationMs < 0))
    )
      invalid();
  }
  return {
    digest: await digest([
      "cache-declaration",
      target,
      ...keyDefinition(declaration.key),
      String(declaration.restoreKeys?.length ?? 0),
      ...(declaration.restoreKeys ?? []),
      budget?.maxBytes === undefined ? "maxBytes:unset" : `maxBytes:${budget.maxBytes}`,
      budget?.maxDurationMs === undefined
        ? "maxDurationMs:unset"
        : `maxDurationMs:${budget.maxDurationMs}`,
    ]),
    target,
  };
};

const SHA256 = /^[0-9a-f]{64}$/;

interface CacheRef {
  readonly archiveBytes: number;
  readonly archiveDigest: string;
  readonly cacheIdDigest: string;
  readonly declarationDigest: string;
  readonly generation: number;
  readonly key: string;
  readonly keyDigest: string;
  readonly manifest: string;
  readonly objectDigest: string;
  readonly platformDigest: string;
  readonly repositoryDigest: string;
  readonly schema: number;
  readonly scopeDigest: string;
}

interface CacheRevision extends Omit<
  CacheRef,
  "archiveBytes" | "archiveDigest" | "manifest" | "objectDigest"
> {
  readonly ref: string;
  readonly etag: string | null;
}

export interface PendingCache {
  readonly schema: 1;
  readonly id: string;
  readonly declaration: CacheTreeDeclaration;
  readonly target: string;
  readonly revision: CacheRevision;
}

export type PreparedCache =
  | {
      readonly state: "ready";
      readonly pending: PendingCache;
      readonly object: {
        readonly digest: string;
        readonly key: string;
        readonly archiveBytes: number;
        readonly archiveDigest: string;
        readonly manifest: string;
      };
    }
  | {
      readonly state: "skipped";
      readonly id: string;
      readonly reason: "unsafe" | "corrupt" | "unavailable" | "budget";
    };

const canonicalRef = (ref: CacheRef): string =>
  JSON.stringify({
    archiveBytes: ref.archiveBytes,
    archiveDigest: ref.archiveDigest,
    cacheIdDigest: ref.cacheIdDigest,
    declarationDigest: ref.declarationDigest,
    generation: ref.generation,
    key: ref.key,
    keyDigest: ref.keyDigest,
    manifest: ref.manifest,
    objectDigest: ref.objectDigest,
    platformDigest: ref.platformDigest,
    repositoryDigest: ref.repositoryDigest,
    schema: ref.schema,
    scopeDigest: ref.scopeDigest,
  });

const canonicalJson = (text: string): boolean => {
  try {
    const value: unknown = JSON.parse(text);
    return (
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(value) === text
    );
  } catch {
    return false;
  }
};

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
      "archiveBytes,archiveDigest,cacheIdDigest,declarationDigest,generation,key,keyDigest,manifest,objectDigest,platformDigest,repositoryDigest,schema,scopeDigest" ||
    !Number.isSafeInteger(record.archiveBytes) ||
    (record.archiveBytes as number) < 0 ||
    typeof record.archiveDigest !== "string" ||
    typeof record.cacheIdDigest !== "string" ||
    typeof record.declarationDigest !== "string" ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1 ||
    typeof record.key !== "string" ||
    !validText(record.key, 1, 1024) ||
    typeof record.keyDigest !== "string" ||
    typeof record.manifest !== "string" ||
    byteLength(record.manifest) > 16 * 1024 ||
    !canonicalJson(record.manifest) ||
    typeof record.objectDigest !== "string" ||
    typeof record.platformDigest !== "string" ||
    typeof record.repositoryDigest !== "string" ||
    !Number.isSafeInteger(record.schema) ||
    typeof record.scopeDigest !== "string" ||
    ![
      record.cacheIdDigest,
      record.archiveDigest,
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
  expected: Omit<
    CacheRef,
    "archiveBytes" | "archiveDigest" | "generation" | "manifest" | "objectDigest"
  >,
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

const cacheKey = async (key: CacheKey, files: CacheFiles): Promise<string> => {
  validateKeyDefinition(key);
  if (typeof key === "string") return key;
  const fields: Array<string | Uint8Array> = ["files", String(key.files.length)];
  for (const path of key.files.toSorted()) {
    const entry = await files.inspect(path);
    if (entry.type !== "file" && entry.type !== "missing") invalid();
    fields.push(path, entry.type);
    if (entry.type === "file") fields.push(entry.bytes);
  }
  return `${key.prefix ?? ""}${await digest(fields)}`;
};

const keyDigest = async (key: string): Promise<string> => await digest(["string", key]);

const encodedKey = (key: string): string =>
  [...encoder.encode(key)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const refPath = (
  repository: string,
  scope: string,
  cacheId: string,
  platform: string,
  key: string,
): string => `refs/${repository}/${scope}/${cacheId}/${platform}/${encodedKey(key)}.json`;

const sameArchive = (left: SnapshotArchive, right: SnapshotArchive): boolean =>
  left.path === right.path && left.bytes === right.bytes && left.digest === right.digest;

const safeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const validateCapture = (
  capture: SnapshotCapture,
  budget: CacheTreeDeclaration["budget"],
): void => {
  if (
    !safeInteger(capture.archive.bytes) ||
    !SHA256.test(capture.archive.digest) ||
    !safeInteger(capture.fileCount) ||
    !safeInteger(capture.byteCount) ||
    !safeInteger(capture.diskBytes) ||
    !safeInteger(capture.entryCount) ||
    !safeInteger(capture.uniqueInodes) ||
    !safeInteger(capture.maxDepth) ||
    !SHA256.test(capture.treeDigest) ||
    !safeInteger(capture.durationMs) ||
    capture.entryCount > 1_000_000 ||
    capture.uniqueInodes > capture.entryCount ||
    capture.fileCount > capture.entryCount ||
    capture.maxDepth > 256
  ) {
    throw new CacheError("corrupt cache snapshot");
  }
  if (
    (budget?.maxBytes !== undefined &&
      Math.max(capture.archive.bytes, capture.byteCount, capture.diskBytes) > budget.maxBytes) ||
    (budget?.maxDurationMs !== undefined && capture.durationMs > budget.maxDurationMs)
  ) {
    throw new CacheError("cache snapshot exceeds budget");
  }
};

const manifestOf = (
  pending: PendingCache,
  context: CacheContext,
  capture: SnapshotCapture,
): string =>
  JSON.stringify({
    archiveDigest: capture.archive.digest,
    byteCount: capture.byteCount,
    declarationDigest: pending.revision.declarationDigest,
    entryCount: capture.entryCount,
    fileCount: capture.fileCount,
    keyDigest: pending.revision.keyDigest,
    maxDepth: capture.maxDepth,
    name: pending.id,
    platform: {
      architecture: context.platform.architecture,
      imageDigest: context.platform.imageDigest,
      os: context.platform.os,
      runnerAbi: context.platform.runnerAbi,
    },
    schema: context.platform.schema,
    target: pending.target,
    treeDigest: capture.treeDigest,
    uniqueInodes: capture.uniqueInodes,
  });

const validateStoredObject = async (
  ref: CacheRef,
  expected: Omit<
    CacheRef,
    "archiveBytes" | "archiveDigest" | "generation" | "manifest" | "objectDigest"
  >,
  name: string,
  target: string,
  context: CacheContext,
): Promise<{
  readonly byteCount: number;
  readonly entryCount: number;
  readonly fileCount: number;
  readonly maxDepth: number;
  readonly treeDigest: string;
  readonly uniqueInodes: number;
}> => {
  let value: unknown;
  try {
    value = JSON.parse(ref.manifest);
  } catch {
    throw new CacheError("invalid cache manifest");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CacheError("invalid cache manifest");
  }
  const record = value as Record<string, unknown>;
  const platform = record.platform;
  if (
    Object.keys(record).join(",") !==
      "archiveDigest,byteCount,declarationDigest,entryCount,fileCount,keyDigest,maxDepth,name,platform,schema,target,treeDigest,uniqueInodes" ||
    !platform ||
    typeof platform !== "object" ||
    Array.isArray(platform) ||
    Object.keys(platform).join(",") !== "architecture,imageDigest,os,runnerAbi" ||
    !safeInteger(record.byteCount as number) ||
    !safeInteger(record.entryCount as number) ||
    !safeInteger(record.fileCount as number) ||
    !safeInteger(record.maxDepth as number) ||
    !safeInteger(record.uniqueInodes as number) ||
    typeof record.treeDigest !== "string" ||
    !SHA256.test(record.treeDigest) ||
    (record.fileCount as number) > (record.entryCount as number) ||
    (record.uniqueInodes as number) > (record.entryCount as number) ||
    (record.maxDepth as number) > 256 ||
    record.archiveDigest !== ref.archiveDigest ||
    record.declarationDigest !== expected.declarationDigest ||
    record.keyDigest !== expected.keyDigest ||
    record.name !== name ||
    record.schema !== expected.schema ||
    record.target !== target ||
    (platform as Record<string, unknown>).architecture !== context.platform.architecture ||
    (platform as Record<string, unknown>).imageDigest !== context.platform.imageDigest ||
    (platform as Record<string, unknown>).os !== context.platform.os ||
    (platform as Record<string, unknown>).runnerAbi !== context.platform.runnerAbi ||
    JSON.stringify(record) !== ref.manifest
  ) {
    throw new CacheError("invalid cache manifest");
  }
  const expectedDigest = await digest([
    "cache-object",
    ref.manifest,
    ref.archiveDigest,
    String(ref.archiveBytes),
  ]);
  if (expectedDigest !== ref.objectDigest) throw new CacheError("invalid cache object evidence");
  return {
    byteCount: record.byteCount as number,
    entryCount: record.entryCount as number,
    fileCount: record.fileCount as number,
    maxDepth: record.maxDepth as number,
    treeDigest: record.treeDigest,
    uniqueInodes: record.uniqueInodes as number,
  };
};

export class Cache {
  readonly #context: CacheContext;
  readonly #current: () => Promise<boolean>;
  readonly #declarations = new Map<
    string,
    {
      readonly cacheIdDigest?: string;
      readonly declarationDigest: string;
      readonly key?: string;
      readonly keyDigest?: string;
      readonly target: string;
    }
  >();
  readonly #pending = new Map<string, PendingCache>();
  readonly #files: CacheFiles;
  readonly #refs: CacheRefs;
  readonly #restore: CacheRestore | undefined;
  readonly #snapshots: CacheSnapshots | undefined;
  readonly #diagnose: (diagnostic: CacheDiagnostic) => void;
  readonly #meter: Meter | undefined;

  constructor(options: CacheOptions) {
    this.#context = options.context;
    this.#current = options.current;
    this.#files = options.files;
    this.#refs = options.refs;
    this.#restore = options.restore;
    this.#snapshots = options.snapshots;
    this.#diagnose = options.diagnose ?? (() => {});
    this.#meter = options.meter;
  }

  // fallow-ignore-next-line unused-class-member -- called through the generated host binding
  async record(id: string, declaration: CacheTreeDeclaration) {
    const result = await this.restore(id, declaration);
    const pending = this.#pending.get(id);
    return pending ? { result, pending } : { result };
  }

  async #validatePending(pending: PendingCache): Promise<void> {
    if (
      !pending ||
      typeof pending !== "object" ||
      Object.keys(pending).sort().join(",") !== "declaration,id,revision,schema,target" ||
      pending.schema !== 1 ||
      normalizedCacheTarget(pending.declaration.path) !== pending.target ||
      (pending.revision.etag !== null && !validText(pending.revision.etag, 1, 1024))
    ) {
      throw new CacheError("invalid pending cache");
    }
    const declarationKeys = Object.keys(pending.declaration).sort().join(",");
    if (
      ![
        "key,path",
        "budget,key,path",
        "key,path,restoreKeys",
        "budget,key,path,restoreKeys",
      ].includes(declarationKeys)
    ) {
      throw new CacheError("invalid pending cache");
    }
    const budget = pending.declaration.budget;
    if (
      budget &&
      !["maxBytes", "maxDurationMs", "maxBytes,maxDurationMs"].includes(
        Object.keys(budget).sort().join(","),
      )
    ) {
      throw new CacheError("invalid pending cache");
    }
    await cacheDeclarationEvidence(pending.declaration);
    validateId(pending.id);
    validateKeyDefinition(pending.declaration.key);
    if (
      !pending.revision ||
      typeof pending.revision !== "object" ||
      Object.keys(pending.revision).sort().join(",") !==
        "cacheIdDigest,declarationDigest,etag,generation,key,keyDigest,platformDigest,ref,repositoryDigest,schema,scopeDigest" ||
      !validText(pending.revision.key, 1, 1024) ||
      !SHA256.test(pending.revision.keyDigest)
    ) {
      throw new CacheError("invalid pending cache");
    }
    const scopePlan = scopes(this.#context);
    if ("policy" in scopePlan) throw new CacheError("invalid pending cache");
    const [repositoryDigest, scopeDigest, cacheIdDigest, platformDigest, declarationDigest] =
      await Promise.all([
        digest(["repository", this.#context.repositoryId]),
        digest(["scope", this.#context.repositoryId, scopePlan.write]),
        digest(["cache-id", pending.id]),
        digest([
          "platform",
          String(this.#context.platform.schema),
          this.#context.platform.os,
          this.#context.platform.architecture,
          this.#context.platform.imageDigest ?? "",
          this.#context.platform.runnerAbi,
        ]),
        digest(["declaration", pending.id, pending.target, String(this.#context.platform.schema)]),
      ]);
    const expected = {
      cacheIdDigest,
      declarationDigest,
      generation: this.#context.generation,
      platformDigest,
      repositoryDigest,
      schema: this.#context.platform.schema,
      scopeDigest,
      ref: refPath(
        repositoryDigest,
        scopeDigest,
        cacheIdDigest,
        platformDigest,
        pending.revision.key,
      ),
    };
    if (
      Object.entries(expected).some(
        ([field, value]) => pending.revision[field as keyof typeof expected] !== value,
      )
    ) {
      throw new CacheError("invalid pending cache");
    }
    this.#declarations.set(pending.id, {
      cacheIdDigest,
      declarationDigest,
      key: pending.revision.key,
      keyDigest: pending.revision.keyDigest,
      target: pending.target,
    });
  }

  // fallow-ignore-next-line unused-class-member -- called through the generated host binding
  async prepare(pendingCaches: readonly PendingCache[]): Promise<readonly PreparedCache[]> {
    const snapshots = this.#snapshots;
    if (!snapshots) {
      return pendingCaches.map((pending) => ({
        state: "skipped" as const,
        id: pending.id,
        reason: "unavailable" as const,
      }));
    }
    const prepared: PreparedCache[] = [];
    for (const pending of pendingCaches) {
      const started = this.#meter?.now();
      let path: string | undefined;
      try {
        await this.#validatePending(pending);
        const slash = pending.target.lastIndexOf("/");
        path = `${pending.target.slice(0, slash)}/.runway-cache-${crypto.randomUUID()}.sqsh`;
        const capture = await snapshots.capture({
          target: pending.target,
          path,
          budget: pending.declaration.budget,
        });
        if (capture.state === "skipped") {
          this.#diagnose({ id: pending.id, state: "skipped", reason: capture.reason });
          prepared.push({ state: "skipped", id: pending.id, reason: capture.reason });
          this.#observe(() =>
            this.#meter?.record({
              type: "cache",
              state: "skipped",
              durationMs: this.#elapsed(started),
              bytes: 0,
            }),
          );
          continue;
        }
        if (capture.archive.path !== path) throw new CacheError("corrupt cache snapshot");
        validateCapture(capture, pending.declaration.budget);
        const manifest = manifestOf(pending, this.#context, capture);
        if (byteLength(manifest) > 16 * 1024) throw new CacheError("corrupt cache snapshot");
        const objectDigest = await digest([
          "cache-object",
          manifest,
          capture.archive.digest,
          String(capture.archive.bytes),
        ]);
        const key = `content/${objectDigest}.sqsh`;
        const uploaded = await snapshots.upload({ key, path, expected: capture.archive });
        if (
          !["stored", "present"].includes(uploaded.state) ||
          !sameArchive(uploaded, capture.archive)
        ) {
          throw new CacheError("corrupt cache snapshot");
        }
        prepared.push({
          state: "ready",
          pending: structuredClone(pending),
          object: {
            digest: objectDigest,
            key,
            archiveBytes: capture.archive.bytes,
            archiveDigest: capture.archive.digest,
            manifest,
          },
        });
      } catch (error) {
        const reason =
          error instanceof CacheError && error.message.includes("unsafe")
            ? "unsafe"
            : error instanceof CacheError && error.message.includes("budget")
              ? "budget"
              : error instanceof CacheError && error.message.includes("corrupt")
                ? "corrupt"
                : "unavailable";
        this.#diagnose({ id: pending.id, state: "skipped", reason });
        prepared.push({ state: "skipped", id: pending.id, reason });
        this.#observe(() =>
          this.#meter?.record({
            type: "cache",
            state: "skipped",
            durationMs: this.#elapsed(started),
            bytes: 0,
          }),
        );
      } finally {
        if (path) await snapshots.remove(path).catch(() => {});
      }
    }
    return prepared;
  }

  // fallow-ignore-next-line unused-class-member -- called through the generated host binding
  async commit(preparedCaches: readonly PreparedCache[]): Promise<void> {
    for (const prepared of preparedCaches) {
      if (prepared.state === "skipped") continue;
      const started = this.#meter?.now();
      try {
        await this.#validatePending(prepared.pending);
        if (
          !prepared.object ||
          Object.keys(prepared.object).sort().join(",") !==
            "archiveBytes,archiveDigest,digest,key,manifest" ||
          !SHA256.test(prepared.object.digest) ||
          !SHA256.test(prepared.object.archiveDigest) ||
          !safeInteger(prepared.object.archiveBytes) ||
          prepared.object.key !== `content/${prepared.object.digest}.sqsh` ||
          prepared.object.manifest !==
            JSON.stringify(JSON.parse(prepared.object.manifest) as Record<string, unknown>) ||
          byteLength(prepared.object.manifest) > 16 * 1024
        ) {
          throw new CacheError("invalid prepared cache");
        }
        await this.publish(prepared.pending.revision, {
          digest: prepared.object.digest,
          archiveBytes: prepared.object.archiveBytes,
          archiveDigest: prepared.object.archiveDigest,
          manifest: prepared.object.manifest,
        });
        this.#diagnose({ id: prepared.pending.id, state: "saved" });
        this.#observe(() =>
          this.#meter?.record({
            type: "cache",
            state: "saved",
            durationMs: this.#elapsed(started),
            bytes: Number(
              (JSON.parse(prepared.object.manifest) as { readonly byteCount?: unknown })
                .byteCount ?? 0,
            ),
          }),
        );
      } catch {
        this.#diagnose({ id: prepared.pending.id, state: "skipped", reason: "conflict" });
        this.#observe(() =>
          this.#meter?.record({
            type: "cache",
            state: "skipped",
            durationMs: this.#elapsed(started),
            bytes: 0,
          }),
        );
      }
    }
  }

  async restore(id: string, declaration: CacheTreeDeclaration) {
    validateId(id);
    await cacheDeclarationEvidence(declaration);
    let lookup: Awaited<ReturnType<Cache["lookup"]>>;
    try {
      lookup = await this.lookup(id, declaration);
    } catch (error) {
      if (error instanceof CacheError) {
        if (
          error.message === "invalid cache ref" ||
          error.message === "invalid cache manifest" ||
          error.message === "invalid cache object evidence"
        ) {
          return { state: "miss" as const, reason: "corrupt" as const };
        }
        throw error;
      }
      return { state: "miss" as const, reason: "unavailable" as const };
    }
    if (lookup.state === "skipped") {
      this.#pending.delete(id);
      return { state: "skipped" as const, reason: lookup.reason };
    }
    const restore = this.#restore;
    const inspector = restore ?? this.#snapshots;
    const target = normalizedCacheTarget(declaration.path);
    if (lookup.revision && inspector) {
      let targetState: Awaited<ReturnType<CacheRestore["inspect"]>>;
      try {
        targetState = await inspector.inspect(target);
      } catch {
        this.#pending.delete(id);
        return { state: "miss" as const, reason: "unavailable" as const };
      }
      if (!(["absent", "empty", "nonempty"] as const).includes(targetState)) {
        this.#pending.delete(id);
        return { state: "miss" as const, reason: "corrupt" as const };
      }
      if (targetState === "nonempty") {
        this.#pending.delete(id);
        return { state: "skipped" as const, reason: "target" as const };
      }
      this.#pending.set(id, {
        schema: 1,
        id,
        declaration: structuredClone(declaration),
        target,
        revision: lookup.revision,
      });
    } else {
      this.#pending.delete(id);
    }
    if (lookup.state === "miss") {
      return { state: "miss" as const, reason: lookup.reason ?? ("absent" as const) };
    }
    if (!restore) return { state: "miss" as const, reason: "unavailable" as const };
    const slash = target.lastIndexOf("/");
    const staging = `${target.slice(0, slash)}/.runway-cache-${crypto.randomUUID()}`;
    let staged: Awaited<ReturnType<CacheRestore["stage"]>>;
    try {
      staged = await restore.stage({
        object: lookup.object,
        path: staging,
        target,
        budget: declaration.budget,
      });
    } catch {
      await restore.remove(staging).catch(() => {});
      return { state: "miss" as const, reason: "unavailable" as const };
    }
    if (staged.state === "miss") {
      await restore.remove(staging).catch(() => {});
      if (
        Object.keys(staged).sort().join(",") === "reason,state" &&
        ["absent", "budget", "corrupt", "unavailable"].includes(staged.reason)
      ) {
        return staged;
      }
      return { state: "miss" as const, reason: "corrupt" as const };
    }
    if (
      Object.keys(staged).sort().join(",") !==
        "archiveBytes,archiveDigest,byteCount,diskBytes,entryCount,fileCount,maxDepth,state,treeDigest,uniqueInodes" ||
      staged.archiveBytes !== lookup.object.archiveBytes ||
      staged.archiveDigest !== lookup.object.archiveDigest ||
      staged.byteCount !== lookup.object.byteCount ||
      staged.entryCount !== lookup.object.entryCount ||
      staged.fileCount !== lookup.object.fileCount ||
      staged.maxDepth !== lookup.object.maxDepth ||
      staged.treeDigest !== lookup.object.treeDigest ||
      staged.uniqueInodes !== lookup.object.uniqueInodes ||
      !safeInteger(staged.byteCount) ||
      !safeInteger(staged.diskBytes) ||
      !safeInteger(staged.entryCount) ||
      !safeInteger(staged.fileCount) ||
      !safeInteger(staged.maxDepth) ||
      !safeInteger(staged.uniqueInodes)
    ) {
      await restore.remove(staging).catch(() => {});
      return { state: "miss" as const, reason: "corrupt" as const };
    }
    if (
      declaration.budget?.maxBytes !== undefined &&
      Math.max(staged.archiveBytes, staged.byteCount, staged.diskBytes) >
        declaration.budget.maxBytes
    ) {
      await restore.remove(staging).catch(() => {});
      return { state: "miss" as const, reason: "budget" as const };
    }
    try {
      await restore.rename(staging, target);
    } catch {
      await restore.remove(staging).catch(() => {});
      return { state: "miss" as const, reason: "unavailable" as const };
    }
    return {
      state: "hit" as const,
      bytes: staged.byteCount,
      key: lookup.key,
      match: lookup.match,
    };
  }

  #elapsed(started: number | undefined): number {
    return started === undefined ? 0 : Math.max(0, Math.round(this.#meter!.now() - started));
  }

  async lookup(id: string, declaration: CacheTreeDeclaration) {
    validateId(id);
    validateKeyDefinition(declaration.key);
    const scopePlan = scopes(this.#context);
    if ("policy" in scopePlan) {
      return { state: "skipped" as const, reason: "policy" as const, revision: null };
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(this.#context.platform.imageDigest ?? "")) {
      return { state: "miss" as const, reason: "unavailable" as const, revision: null };
    }
    const target = normalizedCacheTarget(declaration.path);
    const declarationDigest = await digest([
      "declaration",
      id,
      target,
      String(this.#context.platform.schema),
    ]);
    const previous = this.#declarations.get(id);
    if (previous !== undefined && previous.declarationDigest !== declarationDigest) {
      throw new CacheError(`cache declaration collision for ${id}`);
    }
    const reservation = previous ?? { declarationDigest, target };
    if (!previous) this.#declarations.set(id, reservation);
    let key: string;
    let primaryKeyDigest: string;
    try {
      key = await cacheKey(declaration.key, this.#files);
      primaryKeyDigest = await keyDigest(key);
    } catch (error) {
      if (this.#declarations.get(id) === reservation && !reservation.keyDigest) {
        this.#declarations.delete(id);
      }
      throw error;
    }
    const declared = this.#declarations.get(id);
    if (
      (previous?.key !== undefined && previous.key !== key) ||
      (declared?.key !== undefined && declared.key !== key)
    ) {
      throw new CacheError(`cache declaration collision for ${id}`);
    }
    const [repository, cacheId, platform] = await Promise.all([
      digest(["repository", this.#context.repositoryId]),
      digest(["cache-id", id]),
      digest([
        "platform",
        String(this.#context.platform.schema),
        this.#context.platform.os,
        this.#context.platform.architecture,
        this.#context.platform.imageDigest!,
        this.#context.platform.runnerAbi,
      ]),
    ]);
    this.#declarations.set(id, {
      cacheIdDigest: cacheId,
      declarationDigest,
      key,
      keyDigest: primaryKeyDigest,
      target,
    });
    const refs = await Promise.all(
      scopePlan.reads.map(async (scope) => {
        const scopeDigest = await digest(["scope", this.#context.repositoryId, scope]);
        const ref = refPath(repository, scopeDigest, cacheId, platform, key);
        return {
          ref,
          identity: {
            cacheIdDigest: cacheId,
            declarationDigest,
            key,
            keyDigest: primaryKeyDigest,
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
      const observed = await this.#getRef(candidate.ref);
      if (index === 0) writeEtag = observed?.etag ?? null;
      if (!observed) continue;
      const stored = parseRef(await observed.text());
      assertRefIdentity(stored, candidate.identity);
      const manifest = await validateStoredObject(
        stored,
        candidate.identity,
        id,
        target,
        this.#context,
      );
      return {
        state: "hit" as const,
        key: stored.key,
        match: "exact" as const,
        object: {
          digest: stored.objectDigest,
          archiveBytes: stored.archiveBytes,
          archiveDigest: stored.archiveDigest,
          ...manifest,
          manifest: stored.manifest,
        },
        revision: {
          ...refs[0]!.identity,
          ref: refs[0]!.ref,
          etag: writeEtag,
          generation: this.#context.generation,
        },
        source: { ref: candidate.ref, etag: observed.etag },
      };
    }
    for (const candidate of refs) {
      for (const restoreKey of declaration.restoreKeys ?? []) {
        const base = candidate.ref.slice(0, candidate.ref.lastIndexOf("/") + 1);
        const listed = await this.#listRefs(`${base}${encodedKey(restoreKey)}`);
        if (listed.truncated) continue;
        let winner:
          | {
              readonly ref: string;
              readonly uploadedAtMs: number;
              readonly observed: NonNullable<Awaited<ReturnType<CacheRefs["get"]>>>;
              readonly stored: CacheRef;
            }
          | undefined;
        for (const listedCandidate of listed.candidates) {
          const observed = await this.#getRef(listedCandidate.key);
          if (!observed) continue;
          const stored = parseRef(await observed.text());
          if (!stored.key.startsWith(restoreKey)) continue;
          if (
            listedCandidate.key !==
            refPath(
              repository,
              stored.scopeDigest,
              stored.cacheIdDigest,
              stored.platformDigest,
              stored.key,
            )
          ) {
            throw new CacheError("cache ref identity mismatch");
          }
          if ((await keyDigest(stored.key)) !== stored.keyDigest) {
            throw new CacheError("cache ref identity mismatch");
          }
          const identity = {
            ...candidate.identity,
            key: stored.key,
            keyDigest: stored.keyDigest,
          };
          assertRefIdentity(stored, identity);
          if (
            !winner ||
            listedCandidate.uploadedAtMs > winner.uploadedAtMs ||
            (listedCandidate.uploadedAtMs === winner.uploadedAtMs &&
              listedCandidate.key > winner.ref)
          ) {
            winner = {
              ref: listedCandidate.key,
              uploadedAtMs: listedCandidate.uploadedAtMs,
              observed,
              stored,
            };
          }
        }
        if (!winner) continue;
        const identity = {
          ...candidate.identity,
          key: winner.stored.key,
          keyDigest: winner.stored.keyDigest,
        };
        const manifest = await validateStoredObject(
          winner.stored,
          identity,
          id,
          target,
          this.#context,
        );
        return {
          state: "hit" as const,
          key: winner.stored.key,
          match: "restore" as const,
          object: {
            digest: winner.stored.objectDigest,
            archiveBytes: winner.stored.archiveBytes,
            archiveDigest: winner.stored.archiveDigest,
            ...manifest,
            manifest: winner.stored.manifest,
          },
          revision: {
            ...refs[0]!.identity,
            ref: refs[0]!.ref,
            etag: writeEtag,
            generation: this.#context.generation,
          },
          source: { ref: winner.ref, etag: winner.observed.etag },
        };
      }
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

  async publish(
    revision: CacheRevision,
    object: {
      readonly digest: string;
      readonly archiveBytes: number;
      readonly archiveDigest: string;
      readonly manifest: string;
    },
  ) {
    if (
      !revision ||
      !object ||
      !SHA256.test(object.digest) ||
      !SHA256.test(object.archiveDigest) ||
      !safeInteger(object.archiveBytes) ||
      byteLength(object.manifest) > 16 * 1024 ||
      !canonicalJson(object.manifest)
    ) {
      throw new CacheError("invalid cache publication");
    }
    const declared = [...this.#declarations.entries()].find(
      ([, candidate]) =>
        candidate.cacheIdDigest !== undefined &&
        candidate.keyDigest !== undefined &&
        candidate.cacheIdDigest === revision.cacheIdDigest &&
        candidate.declarationDigest === revision.declarationDigest &&
        candidate.keyDigest === revision.keyDigest,
    );
    if (!declared) throw new CacheError("blind cache publication");
    const [id, declaration] = declared;
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
        this.#context.platform.imageDigest!,
        this.#context.platform.runnerAbi,
      ]),
    ]);
    const expected = {
      cacheIdDigest: revision.cacheIdDigest,
      declarationDigest: revision.declarationDigest,
      key: revision.key,
      keyDigest: revision.keyDigest,
      platformDigest,
      repositoryDigest,
      schema: this.#context.platform.schema,
      scopeDigest,
    };
    const expectedRef = refPath(
      repositoryDigest,
      scopeDigest,
      revision.cacheIdDigest,
      platformDigest,
      revision.key,
    );
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
      archiveBytes: object.archiveBytes,
      archiveDigest: object.archiveDigest,
      generation: revision.generation,
      manifest: object.manifest,
      objectDigest: object.digest,
    };
    await validateStoredObject(ref, expected, id, declaration.target, this.#context);
    let onlyIf =
      revision.etag === null ? { etagDoesNotMatch: "*" } : { etagMatches: revision.etag };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const stored = await this.#putRef(revision.ref, canonicalRef(ref), { onlyIf });
      if (stored) return { state: "published" as const };
      const winner = await this.#getRef(revision.ref);
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

  async #getRef(key: string): ReturnType<CacheRefs["get"]> {
    return await this.#refs.get(key);
  }

  async #listRefs(prefix: string): ReturnType<CacheRefs["list"]> {
    return await this.#refs.list(prefix);
  }

  async #putRef(
    key: string,
    text: string,
    options: Parameters<CacheRefs["put"]>[2],
  ): ReturnType<CacheRefs["put"]> {
    return await this.#refs.put(key, text, options);
  }

  // fallow-ignore-next-line unused-class-member -- called through the generated host binding
  async flushMeter(): Promise<void> {
    await this.#meter?.flush().catch(() => {});
  }

  #observe(work: () => void): void {
    try {
      work();
    } catch {}
  }
}
