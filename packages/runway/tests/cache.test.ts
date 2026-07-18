import { createHash } from "node:crypto";

import { expect, test } from "vitest";

import { Cache } from "../src/internal/cache/cache.ts";
import { Meter } from "../src/meter.ts";

const cacheMeter = (classAUsd = 0): Meter =>
  new Meter({
    priceTable: {
      id: "test-cache-prices",
      rates: [
        { source: "container", unit: "vcpu-ms", usdPerUnit: 0 },
        { source: "container", unit: "gib-ms", usdPerUnit: 0 },
        { source: "container", unit: "disk-gb-ms", usdPerUnit: 0 },
        { source: "r2", unit: "class-a", usdPerUnit: classAUsd },
        { source: "r2", unit: "class-b", usdPerUnit: 0 },
        { source: "r2", unit: "stored-byte-ms", usdPerUnit: 0 },
        { source: "workflow", unit: "step", usdPerUnit: 0 },
      ],
    },
    container: { vcpu: 0.5, memoryGib: 4, diskGb: 8 },
    cache: {
      maxBytes: 1024 * 1024 * 1024,
      maxDurationMs: 60_000,
      save: {
        classAOperations: 9,
        classBOperations: 10,
        storageHorizonMs: 30 * 24 * 60 * 60 * 1_000,
        transferDurationMs: 15 * 60_000,
        workflowSteps: 3,
      },
      restore: {
        classAOperations: 0,
        classBOperations: 4,
        transferDurationMs: 15 * 60_000,
        workflowSteps: 1,
      },
    },
  });

class MemoryRefs {
  readonly objects = new Map<string, { readonly etag: string; readonly text: string }>();
  readonly reads: string[] = [];
  readonly writes: Array<{
    readonly key: string;
    readonly onlyIf: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string };
  }> = [];
  #version = 0;

  async get(
    key: string,
  ): Promise<{ readonly etag: string; readonly text: () => Promise<string> } | null> {
    this.reads.push(key);
    const object = this.objects.get(key);
    return object ? { etag: object.etag, text: async () => object.text } : null;
  }

  async list(prefix: string) {
    return {
      candidates: [...this.objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key, uploadedAtMs) => ({ key, uploadedAtMs })),
      truncated: false,
    };
  }

  async put(
    key: string,
    text: string,
    options: {
      readonly onlyIf: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string };
    },
  ): Promise<{ readonly etag: string } | null> {
    this.writes.push({ key, onlyIf: options.onlyIf });
    const current = this.objects.get(key);
    if (options.onlyIf.etagDoesNotMatch === "*" && current) return null;
    if (options.onlyIf.etagMatches !== undefined && current?.etag !== options.onlyIf.etagMatches) {
      return null;
    }
    const etag = `version-${++this.#version}`;
    this.objects.set(key, { etag, text });
    return { etag };
  }
}

class FlakyRefs extends MemoryRefs {
  failures = 0;

  override async put(
    key: string,
    text: string,
    options: {
      readonly onlyIf: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string };
    },
  ): Promise<{ readonly etag: string } | null> {
    if (this.failures > 0) {
      this.failures -= 1;
      this.writes.push({ key, onlyIf: options.onlyIf });
      return null;
    }
    return await super.put(key, text, options);
  }
}

interface ObservedRevision {
  readonly cacheIdDigest: string;
  readonly declarationDigest: string;
  readonly generation: number;
  readonly key: string;
  readonly keyDigest: string;
  readonly platformDigest: string;
  readonly repositoryDigest: string;
  readonly schema: number;
  readonly scopeDigest: string;
  readonly ref: string;
}

interface Admission {
  readonly type: string;
  readonly ref?: string;
  readonly defaultRef?: string;
  readonly number?: number;
  readonly headRepositoryId?: string;
}

const revisionOf = (result: { readonly revision: ObservedRevision | null }): ObservedRevision => {
  if (!result.revision) throw new Error("expected observation");
  return result.revision;
};

const fixtureDigest = (fields: readonly string[]): string => {
  const hash = createHash("sha256");
  for (const field of fields) {
    const value = Buffer.from(field);
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(value.byteLength));
    hash.update(length);
    hash.update(value);
  }
  return hash.digest("hex");
};

const treeEvidence = {
  diskBytes: 4096,
  entryCount: 1,
  maxDepth: 1,
  treeDigest: "e".repeat(64),
  uniqueInodes: 1,
} as const;

const objectFixture = (
  revision: ObservedRevision,
  variant = "a",
  name = "tools",
  target = "/cache/tools",
) => {
  const archiveDigest = variant.repeat(64);
  const archiveBytes = 4096;
  const manifest = JSON.stringify({
    archiveDigest,
    byteCount: 12,
    declarationDigest: revision.declarationDigest,
    entryCount: treeEvidence.entryCount,
    fileCount: 1,
    keyDigest: revision.keyDigest,
    maxDepth: treeEvidence.maxDepth,
    name,
    platform: {
      architecture: context.platform.architecture,
      imageDigest: context.platform.imageDigest,
      os: context.platform.os,
      runnerAbi: context.platform.runnerAbi,
    },
    schema: revision.schema,
    target,
    treeDigest: treeEvidence.treeDigest,
    uniqueInodes: treeEvidence.uniqueInodes,
  });
  return {
    digest: fixtureDigest(["cache-object", manifest, archiveDigest, String(archiveBytes)]),
    archiveBytes,
    archiveDigest,
    manifest,
  };
};

const refRecord = (
  revision: ObservedRevision,
  variant = "a",
  name = "tools",
  target = "/cache/tools",
): Record<string, unknown> => ({
  archiveBytes: objectFixture(revision, variant, name, target).archiveBytes,
  archiveDigest: objectFixture(revision, variant, name, target).archiveDigest,
  cacheIdDigest: revision.cacheIdDigest,
  declarationDigest: revision.declarationDigest,
  generation: revision.generation,
  key: revision.key,
  keyDigest: revision.keyDigest,
  manifest: objectFixture(revision, variant, name, target).manifest,
  objectDigest: objectFixture(revision, variant, name, target).digest,
  platformDigest: revision.platformDigest,
  repositoryDigest: revision.repositoryDigest,
  schema: revision.schema,
  scopeDigest: revision.scopeDigest,
});

const seed = (
  refs: MemoryRefs,
  revision: ObservedRevision,
  options: {
    readonly etag?: string;
    readonly variant?: string;
    readonly name?: string;
    readonly target?: string;
  } = {},
): void => {
  refs.objects.set(revision.ref, {
    etag: options.etag ?? "version-1",
    text: JSON.stringify(refRecord(revision, options.variant, options.name, options.target)),
  });
};

const context = {
  repositoryId: "github:17",
  workflowId: "check",
  generation: 1,
  admission: {
    type: "push" as const,
    ref: "refs/heads/main",
    defaultRef: "refs/heads/main",
  },
  platform: {
    schema: 2,
    os: "linux",
    architecture: "amd64",
    imageDigest: `sha256:${"1".repeat(64)}`,
    runnerAbi: "runway-sandbox-v2",
  },
};

test("string and exact-source file keys have stable canonical identities, including missing files", async () => {
  const refs = new MemoryRefs();
  const files = new Map<string, Uint8Array>([
    ["pnpm-lock.yaml", new TextEncoder().encode("lockfile-v1")],
  ]);
  const create = () =>
    new Cache({
      context,
      refs,
      files: {
        inspect: async (path: string) => {
          const bytes = files.get(path);
          return bytes ? { type: "file" as const, bytes } : { type: "missing" as const };
        },
      },
      current: async () => true,
    });

  const stringOne = await create().lookup("tools", { key: "v1", path: "/cache/tools" });
  const stringTwo = await create().lookup("tools", { key: "v1", path: "/cache/tools" });
  const filesOne = await create().lookup("dependencies", {
    key: { files: ["missing.lock", "pnpm-lock.yaml"], prefix: "linux" },
    path: "/cache/dependencies",
  });
  const filesTwo = await create().lookup("dependencies", {
    key: { files: ["missing.lock", "pnpm-lock.yaml"], prefix: "linux" },
    path: "/cache/dependencies",
  });
  const stringOneRevision = revisionOf(stringOne);
  const stringTwoRevision = revisionOf(stringTwo);
  const filesOneRevision = revisionOf(filesOne);
  const filesTwoRevision = revisionOf(filesTwo);

  expect(stringOne).toMatchObject({ state: "miss", revision: { etag: null } });
  expect(stringTwoRevision.ref).toBe(stringOneRevision.ref);
  expect(filesTwoRevision.ref).toBe(filesOneRevision.ref);
  expect(filesOneRevision.ref).not.toBe(stringOneRevision.ref);

  files.set("pnpm-lock.yaml", new TextEncoder().encode("lockfile-v2"));
  const changed = await create().lookup("dependencies", {
    key: { files: ["missing.lock", "pnpm-lock.yaml"], prefix: "linux" },
    path: "/cache/dependencies",
  });
  files.set("missing.lock", new Uint8Array());
  const present = await create().lookup("dependencies", {
    key: { files: ["missing.lock", "pnpm-lock.yaml"], prefix: "linux" },
    path: "/cache/dependencies",
  });

  expect(revisionOf(changed).ref).not.toBe(filesOneRevision.ref);
  expect(revisionOf(present).ref).not.toBe(revisionOf(changed).ref);
});

test("restore keys choose the newest matching prefix while preserving the primary publication key", async () => {
  const refs = new MemoryRefs();
  const create = (generation: number) =>
    new Cache({
      context: { ...context, generation },
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
    });
  const older = revisionOf(
    await create(1).lookup("dependencies", {
      key: "dependencies-linux-old",
      path: "/cache/dependencies",
    }),
  );
  seed(refs, older, {
    name: "dependencies",
    target: "/cache/dependencies",
  });
  const newer = revisionOf(
    await create(1).lookup("dependencies", {
      key: "dependencies-linux-new",
      path: "/cache/dependencies",
    }),
  );
  seed(refs, newer, {
    etag: "version-2",
    name: "dependencies",
    target: "/cache/dependencies",
  });

  const lookup = await create(1).lookup("dependencies", {
    key: "dependencies-linux-current",
    restoreKeys: ["dependencies-linux-"],
    path: "/cache/dependencies",
  });

  expect(lookup).toMatchObject({
    state: "hit",
    key: "dependencies-linux-new",
    match: "restore",
    revision: {
      key: "dependencies-linux-current",
      etag: null,
    },
    source: { ref: newer.ref },
  });
});

test("a hit stages beside its target and becomes visible only after verified rename", async () => {
  const refs = new MemoryRefs();
  const events: string[] = [];
  let target: "absent" | "empty" | "nonempty" = "absent";
  const create = (restore = true) =>
    new Cache({
      context,
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
      ...(restore
        ? {
            restore: {
              inspect: async (path: string) => {
                events.push(`inspect:${path}:${target}`);
                return target;
              },
              stage: async ({ object, path }) => {
                events.push(`stage:${object.digest}:${path}`);
                return {
                  state: "ready" as const,
                  archiveBytes: 4096,
                  archiveDigest: "c".repeat(64),
                  byteCount: 12,
                  ...treeEvidence,
                  fileCount: 1,
                };
              },
              remove: async (path: string) => {
                events.push(`remove:${path}`);
                target = "absent";
              },
              rename: async (from: string, to: string) => {
                events.push(`rename:${from}:${to}`);
                target = "nonempty";
              },
            },
          }
        : {}),
    });
  const declaration = { key: "v1", path: "/cache/tree" } as const;
  const miss = await create(false).lookup("tree", declaration);
  if (!miss.revision) throw new Error("expected observation");
  seed(refs, miss.revision, { variant: "c", name: "tree", target: "/cache/tree" });

  await expect(create().restore("tree", declaration)).resolves.toEqual({
    state: "hit",
    bytes: 12,
    key: "v1",
    match: "exact",
  });
  expect(events[0]).toBe("inspect:/cache/tree:absent");
  expect(events[1]).toMatch(
    new RegExp(
      `^stage:${objectFixture(miss.revision, "c", "tree", "/cache/tree").digest}:/cache/\\.runway-cache-[0-9a-f-]+$`,
    ),
  );
  expect(events[2]).toMatch(/^rename:\/cache\/\.runway-cache-[0-9a-f-]+:\/cache\/tree$/);
});

test("a failed atomic rename preserves an existing empty target", async () => {
  const refs = new MemoryRefs();
  const declaration = { key: "v1", path: "/cache/tree" } as const;
  const base = new Cache({
    context,
    refs,
    files: { inspect: async () => ({ type: "missing" as const }) },
    current: async () => true,
  });
  const miss = await base.lookup("tree", declaration);
  if (!miss.revision) throw new Error("expected observation");
  seed(refs, miss.revision, { variant: "d", name: "tree", target: "/cache/tree" });
  let target = "empty" as "empty" | "absent";
  const removals: string[] = [];
  const cache = new Cache({
    context,
    refs,
    files: { inspect: async () => ({ type: "missing" as const }) },
    current: async () => true,
    restore: {
      inspect: async () => target,
      stage: async () => ({
        state: "ready",
        archiveBytes: 4096,
        archiveDigest: "d".repeat(64),
        byteCount: 12,
        ...treeEvidence,
        fileCount: 1,
      }),
      remove: async (path) => {
        removals.push(path);
        if (path === "/cache/tree") target = "absent";
      },
      rename: async () => {
        throw new Error("rename lost");
      },
    },
  });

  await expect(cache.restore("tree", declaration)).resolves.toEqual({
    state: "miss",
    reason: "unavailable",
  });
  expect(target).toBe("empty");
  expect(removals).toHaveLength(1);
  expect(removals[0]).toMatch(/^\/cache\/\.runway-cache-/);
});

test("a poisoned canonical manifest is a corrupt miss before staging or target mutation", async () => {
  const refs = new MemoryRefs();
  const declaration = { key: "v1", path: "/cache/tree" } as const;
  const base = new Cache({
    context,
    refs,
    files: { inspect: async () => ({ type: "missing" as const }) },
    current: async () => true,
  });
  const miss = await base.lookup("tree", declaration);
  if (!miss.revision) throw new Error("expected observation");
  seed(refs, miss.revision, { variant: "d", name: "tree", target: "/cache/tree" });
  const stored = refs.objects.get(miss.revision.ref)!;
  const ref = JSON.parse(stored.text) as Record<string, unknown>;
  ref.manifest = (ref.manifest as string).replace(
    '"target":"/cache/tree"',
    '"target":"/cache/other"',
  );
  refs.objects.set(miss.revision.ref, { ...stored, text: JSON.stringify(ref) });
  let staged = false;
  const cache = new Cache({
    context,
    refs,
    files: { inspect: async () => ({ type: "missing" as const }) },
    current: async () => true,
    restore: {
      inspect: async () => "absent",
      stage: async () => {
        staged = true;
        throw new Error("must not stage");
      },
      remove: async () => {},
      rename: async () => {},
    },
  });

  await expect(cache.restore("tree", declaration)).resolves.toEqual({
    state: "miss",
    reason: "corrupt",
  });
  expect(staged).toBe(false);
});

test("wrong archive or extracted evidence and interrupted extraction preserve the target", async () => {
  const declaration = { key: "v1", path: "/cache/tree" } as const;
  const cases = [
    {
      name: "archive digest",
      stage: {
        state: "ready" as const,
        archiveBytes: 4096,
        archiveDigest: "e".repeat(64),
        byteCount: 12,
        ...treeEvidence,
        fileCount: 1,
      },
      reason: "corrupt",
    },
    {
      name: "archive size",
      stage: {
        state: "ready" as const,
        archiveBytes: 4097,
        archiveDigest: "d".repeat(64),
        byteCount: 12,
        ...treeEvidence,
        fileCount: 1,
      },
      reason: "corrupt",
    },
    {
      name: "decompression bomb",
      stage: {
        state: "ready" as const,
        archiveBytes: 4096,
        archiveDigest: "d".repeat(64),
        byteCount: 12_000_000,
        ...treeEvidence,
        fileCount: 1,
      },
      reason: "corrupt",
    },
    {
      name: "partial extraction",
      stage: undefined,
      reason: "unavailable",
    },
  ] as const;
  for (const example of cases) {
    const refs = new MemoryRefs();
    const base = new Cache({
      context,
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
    });
    const miss = await base.lookup("tree", declaration);
    if (!miss.revision) throw new Error("expected observation");
    seed(refs, miss.revision, { variant: "d", name: "tree", target: "/cache/tree" });
    let target = "empty";
    let renames = 0;
    const removals: string[] = [];
    const cache = new Cache({
      context,
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
      restore: {
        inspect: async () => "empty",
        stage: async () => {
          if (!example.stage) throw new Error("concurrent deletion during extraction");
          return example.stage;
        },
        remove: async (path) => {
          removals.push(path);
        },
        rename: async () => {
          target = "changed";
          renames += 1;
        },
      },
    });

    await expect(cache.restore("tree", declaration), example.name).resolves.toEqual({
      state: "miss",
      reason: example.reason,
    });
    expect(target, example.name).toBe("empty");
    expect(renames, example.name).toBe(0);
    expect(removals, example.name).toHaveLength(1);
    expect(removals[0]).toMatch(/^\/cache\/\.runway-cache-/);
  }
});

test("a nonempty target is left unchanged without staging a hit", async () => {
  const refs = new MemoryRefs();
  const declaration = { key: "v1", path: "/cache/tree" } as const;
  const base = new Cache({
    context,
    refs,
    files: { inspect: async () => ({ type: "missing" as const }) },
    current: async () => true,
  });
  const miss = await base.lookup("tree", declaration);
  if (!miss.revision) throw new Error("expected observation");
  seed(refs, miss.revision, { variant: "e", name: "tree", target: "/cache/tree" });
  const cache = new Cache({
    context,
    refs,
    files: { inspect: async () => ({ type: "missing" as const }) },
    current: async () => true,
    restore: {
      inspect: async () => "nonempty",
      stage: async () => {
        throw new Error("must not stage over a nonempty target");
      },
      remove: async () => {
        throw new Error("must not remove a nonempty target");
      },
      rename: async () => {
        throw new Error("must not rename over a nonempty target");
      },
    },
  });

  await expect(cache.restore("tree", declaration)).resolves.toEqual({
    state: "skipped",
    reason: "target",
  });
});

test("cache identifiers and file keys reject invalid lengths, paths, and file kinds before ref access", async () => {
  const refs = new MemoryRefs();
  const cache = new Cache({
    context,
    refs,
    files: {
      inspect: async (path: string) => {
        if (path === "link") return { type: "symlink" as const };
        if (path === "directory") return { type: "directory" as const };
        return { type: "missing" as const };
      },
    },
    current: async () => true,
  });
  const invalid: ReadonlyArray<readonly [string, Parameters<Cache["lookup"]>[1]]> = [
    ["", { key: "valid", path: "/cache/x" }],
    [`x${"é".repeat(64)}`, { key: "valid", path: "/cache/x" }],
    ["valid", { key: "", path: "/cache/x" }],
    ["valid", { key: "é".repeat(257), path: "/cache/x" }],
    ["valid", { key: { files: [] as never }, path: "/cache/x" }],
    [
      "valid",
      {
        key: { files: Array.from({ length: 65 }, (_, index) => `file-${index}`) as never },
        path: "/cache/x",
      },
    ],
    ["valid", { key: { files: ["a", "a"] }, path: "/cache/x" }],
    ["valid", { key: { files: ["b", "a"] }, path: "/cache/x" }],
    ["valid", { key: { files: ["/absolute"] }, path: "/cache/x" }],
    ["valid", { key: { files: ["../escape"] }, path: "/cache/x" }],
    ["valid", { key: { files: ["a/../escape"] }, path: "/cache/x" }],
    ["valid", { key: { files: ["a\\windows"] }, path: "/cache/x" }],
    ["valid", { key: { files: ["x".repeat(513)] }, path: "/cache/x" }],
    ["valid", { key: { files: ["link"] }, path: "/cache/x" }],
    ["valid", { key: { files: ["directory"] }, path: "/cache/x" }],
  ];

  for (const [id, declaration] of invalid) {
    await expect(cache.lookup(id, declaration)).rejects.toThrow("invalid cache");
  }
  expect(refs.reads).toEqual([]);
});

test("a cache declaration is idempotent by ID and collides on a different key or target in one run", async () => {
  const refs = new MemoryRefs();
  const create = () =>
    new Cache({
      context,
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
    });
  const cache = create();

  const first = await cache.lookup("dependencies", { key: "v1", path: "node_modules" });
  const retry = await cache.lookup("dependencies", { key: "v1", path: "./node_modules" });

  expect(revisionOf(retry).ref).toBe(revisionOf(first).ref);
  const readsBeforeCollision = refs.reads.length;
  await expect(cache.lookup("dependencies", { key: "v2", path: "node_modules" })).rejects.toThrow(
    "cache declaration collision",
  );
  const targetCollision = create();
  await targetCollision.lookup("dependencies", { key: "v1", path: "node_modules" });
  await expect(
    targetCollision.lookup("dependencies", { key: "v1", path: "/cache/dependencies" }),
  ).rejects.toThrow("cache declaration collision");
  expect(refs.reads.length).toBe(readsBeforeCollision + 1);
});

test("concurrent declarations cannot race past the ID collision invariant", async () => {
  const refs = new MemoryRefs();
  const cache = new Cache({
    context,
    refs,
    files: { inspect: async () => ({ type: "missing" as const }) },
    current: async () => true,
  });

  const outcomes = await Promise.allSettled([
    cache.lookup("dependencies", { key: "v1", path: "/cache/one" }),
    cache.lookup("dependencies", { key: "v2", path: "/cache/two" }),
  ]);

  expect(outcomes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(refs.reads).toHaveLength(1);
});

test("authenticated admissions derive the exact cache read scopes and fork policy", async () => {
  const declaration = { key: "v1", path: "/cache/tools" } as const;
  const lookup = async (admission: Admission, repositoryId = "github:17", workflowId = "check") => {
    const refs = new MemoryRefs();
    const cache = new Cache({
      context: { ...context, repositoryId, workflowId, admission },
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
    });
    return { result: await cache.lookup("tools", declaration), reads: refs.reads };
  };

  const trusted = await lookup({
    type: "push",
    ref: "refs/heads/main",
    defaultRef: "refs/heads/main",
  });
  const branch = await lookup({
    type: "push",
    ref: "refs/heads/feature",
    defaultRef: "refs/heads/main",
  });
  const pullRequest = await lookup({
    type: "pull_request",
    number: 41,
    headRepositoryId: "github:17",
    defaultRef: "refs/heads/main",
  });
  const webhook = await lookup({ type: "webhook" });
  const cron = await lookup({ type: "cron" });
  const fork = await lookup({
    type: "pull_request",
    number: 42,
    headRepositoryId: "github:99",
    defaultRef: "refs/heads/main",
  });
  const forkWithoutPlatform = await (async () => {
    const refs = new MemoryRefs();
    const cache = new Cache({
      context: {
        ...context,
        admission: {
          type: "pull_request",
          number: 43,
          headRepositoryId: "github:99",
          defaultRef: "refs/heads/main",
        },
        platform: {
          schema: context.platform.schema,
          os: context.platform.os,
          architecture: context.platform.architecture,
          runnerAbi: context.platform.runnerAbi,
        },
      },
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => false,
    });
    return { result: await cache.restore("tools", declaration), reads: refs.reads };
  })();

  expect(trusted.reads).toHaveLength(1);
  expect(branch.reads).toHaveLength(2);
  expect(branch.reads[1]).toBe(trusted.reads[0]);
  expect(pullRequest.reads).toHaveLength(2);
  expect(pullRequest.reads[1]).toBe(trusted.reads[0]);
  expect(new Set([trusted.reads[0], branch.reads[0], pullRequest.reads[0]])).toHaveLength(3);
  expect(webhook.reads).toEqual(cron.reads);
  expect(webhook.reads).toHaveLength(1);
  expect(webhook.reads[0]).not.toBe(trusted.reads[0]);
  expect(fork).toMatchObject({ result: { state: "skipped", reason: "policy" }, reads: [] });
  expect(forkWithoutPlatform).toEqual({
    result: { state: "skipped", reason: "policy" },
    reads: [],
  });
});

test("an unavailable platform identity misses before source or ref access", async () => {
  const refs = new MemoryRefs();
  let fileInspections = 0;
  const cache = new Cache({
    context: {
      ...context,
      platform: {
        schema: context.platform.schema,
        os: context.platform.os,
        architecture: context.platform.architecture,
        runnerAbi: context.platform.runnerAbi,
      },
    },
    refs,
    files: {
      inspect: async () => {
        fileInspections += 1;
        return { type: "missing" as const };
      },
    },
    current: async () => false,
  });

  await expect(cache.restore("tools", { key: "v1", path: "/cache/tools" })).resolves.toEqual({
    state: "miss",
    reason: "unavailable",
  });
  expect(fileInspections).toBe(0);
  expect(refs.reads).toEqual([]);
});

test("a ref carrying another repository identity is rejected as poisoning", async () => {
  const refs = new MemoryRefs();
  const create = (repositoryId: string) =>
    new Cache({
      context: { ...context, repositoryId },
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
    });
  const declaration = { key: "v1", path: "/cache/tools" } as const;
  const repositoryA = await create("github:17").lookup("tools", declaration);
  const repositoryB = await create("github:99").lookup("tools", declaration);
  if (!repositoryA.revision || !repositoryB.revision) throw new Error("expected observations");
  const otherRepositoryDigest = repositoryB.revision.repositoryDigest;
  refs.objects.set(repositoryA.revision.ref, {
    etag: "poisoned-version",
    text: JSON.stringify({
      ...refRecord(repositoryA.revision),
      repositoryDigest: otherRepositoryDigest,
    }),
  });

  await expect(create("github:17").lookup("tools", declaration)).rejects.toThrow(
    "cache ref identity mismatch",
  );
});

test("every platform identity dimension independently misses an otherwise matching ref", async () => {
  const refs = new MemoryRefs();
  const declaration = { key: "v1", path: "/cache/tools" } as const;
  const create = (platform = context.platform) =>
    new Cache({
      context: { ...context, platform },
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
    });
  const absent = await create().lookup("tools", declaration);
  if (!absent.revision) throw new Error("expected observation");
  seed(refs, absent.revision, { variant: "b" });

  await expect(create().lookup("tools", declaration)).resolves.toMatchObject({
    state: "hit",
    object: { digest: objectFixture(absent.revision, "b").digest },
    revision: { etag: "version-1" },
  });
  const variants = [
    { ...context.platform, schema: 3 },
    { ...context.platform, os: "freebsd" },
    { ...context.platform, architecture: "aarch64" },
    { ...context.platform, imageDigest: `sha256:${"2".repeat(64)}` },
    { ...context.platform, runnerAbi: "runway-sandbox-v3" },
  ];
  for (const platform of variants) {
    await expect(create(platform).lookup("tools", declaration)).resolves.toMatchObject({
      state: "miss",
      revision: { etag: null },
    });
  }
});

test("misses and hits retain the exact write revision separately from a fallback source revision", async () => {
  const refs = new MemoryRefs();
  const create = (admission: Admission) =>
    new Cache({
      context: { ...context, admission },
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
    });
  const declaration = { key: "v1", path: "/cache/tools" } as const;
  const trusted = await create({
    type: "push",
    ref: "refs/heads/main",
    defaultRef: "refs/heads/main",
  }).lookup("tools", declaration);
  if (!trusted.revision) throw new Error("expected observation");
  seed(refs, trusted.revision, { etag: "trusted-version" });

  const branchCache = create({
    type: "push",
    ref: "refs/heads/feature",
    defaultRef: "refs/heads/main",
  });
  const fallback = await branchCache.lookup("tools", declaration);
  expect(fallback).toMatchObject({
    state: "hit",
    revision: { etag: null },
    source: { ref: trusted.revision.ref, etag: "trusted-version" },
  });
  if (!fallback.revision) throw new Error("expected branch observation");
  seed(refs, fallback.revision, { etag: "branch-version", variant: "b" });
  const readsBeforeOwnHit = refs.reads.length;

  await expect(branchCache.lookup("tools", declaration)).resolves.toMatchObject({
    state: "hit",
    object: { digest: objectFixture(fallback.revision, "b").digest },
    revision: { ref: fallback.revision.ref, etag: "branch-version" },
    source: { ref: fallback.revision.ref, etag: "branch-version" },
  });
  expect(refs.reads.length).toBe(readsBeforeOwnHit + 1);
});

test("publication uses the observed missing or version CAS and writes only the admission's own scope", async () => {
  const refs = new MemoryRefs();
  const create = (admission: Admission) =>
    new Cache({
      context: { ...context, admission },
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
    });
  const declaration = { key: "v1", path: "/cache/tools" } as const;
  const trustedCache = create({
    type: "push",
    ref: "refs/heads/main",
    defaultRef: "refs/heads/main",
  });
  const missing = await trustedCache.lookup("tools", declaration);
  if (!missing.revision) throw new Error("expected observation");

  await expect(
    trustedCache.publish(missing.revision, objectFixture(missing.revision, "a")),
  ).resolves.toMatchObject({ state: "published" });
  const hit = await trustedCache.lookup("tools", declaration);
  if (!hit.revision) throw new Error("expected observation");
  await expect(
    trustedCache.publish(hit.revision, objectFixture(hit.revision, "b")),
  ).resolves.toMatchObject({ state: "published" });

  const branchCache = create({
    type: "push",
    ref: "refs/heads/feature",
    defaultRef: "refs/heads/main",
  });
  const fallback = await branchCache.lookup("tools", declaration);
  if (!fallback.revision) throw new Error("expected observation");
  expect(fallback).toMatchObject({
    state: "hit",
    object: { digest: objectFixture(hit.revision, "b").digest },
  });
  await expect(
    branchCache.publish(fallback.revision, objectFixture(fallback.revision, "c")),
  ).resolves.toMatchObject({ state: "published" });

  expect(refs.writes).toEqual([
    { key: missing.revision.ref, onlyIf: { etagDoesNotMatch: "*" } },
    { key: hit.revision.ref, onlyIf: { etagMatches: "version-1" } },
    { key: fallback.revision.ref, onlyIf: { etagDoesNotMatch: "*" } },
  ]);
  expect(JSON.parse(refs.objects.get(hit.revision.ref)!.text)).toMatchObject({
    objectDigest: objectFixture(hit.revision, "b").digest,
  });
  expect(JSON.parse(refs.objects.get(fallback.revision.ref)!.text)).toMatchObject({
    objectDigest: objectFixture(fallback.revision, "c").digest,
  });
});

test("blind, stale, superseded, and cross-scope cache publications are rejected", async () => {
  const refs = new MemoryRefs();
  const declaration = { key: "v1", path: "/cache/tools" } as const;
  const create = (admission: Admission, current = async () => true, generation = 1) =>
    new Cache({
      context: { ...context, generation, admission },
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current,
    });
  const trustedAdmission = {
    type: "push",
    ref: "refs/heads/main",
    defaultRef: "refs/heads/main",
  };
  const trusted = create(trustedAdmission);
  const missing = await trusted.lookup("tools", declaration);
  if (!missing.revision) throw new Error("expected observation");

  await expect(
    create(trustedAdmission).publish(missing.revision, objectFixture(missing.revision, "a")),
  ).rejects.toThrow("blind cache publication");
  await trusted.publish(missing.revision, objectFixture(missing.revision, "a"));
  const observed = await trusted.lookup("tools", declaration);
  if (!observed.revision) throw new Error("expected observation");
  seed(refs, observed.revision, { etag: "external-version", variant: "b" });
  await expect(
    trusted.publish(observed.revision, objectFixture(observed.revision, "c")),
  ).rejects.toThrow("cache publication stale");

  const superseded = create(trustedAdmission, async () => false);
  const supersededObservation = await superseded.lookup("tools", declaration);
  if (!supersededObservation.revision) throw new Error("expected observation");
  const writesBeforeSuperseded = refs.writes.length;
  await expect(
    superseded.publish(
      supersededObservation.revision,
      objectFixture(supersededObservation.revision, "d"),
    ),
  ).rejects.toThrow("cache publication superseded");
  expect(refs.writes).toHaveLength(writesBeforeSuperseded);

  refs.objects.delete(missing.revision.ref);
  const older = create(trustedAdmission, async () => true, 1);
  const olderObservation = await older.lookup("tools", declaration);
  if (!olderObservation.revision) throw new Error("expected observation");
  seed(refs, { ...olderObservation.revision, generation: 2 }, { variant: "e" });
  await expect(
    older.publish(olderObservation.revision, objectFixture(olderObservation.revision, "e")),
  ).rejects.toThrow("cache publication superseded");

  const branch = create({
    type: "push",
    ref: "refs/heads/feature",
    defaultRef: "refs/heads/main",
  });
  const branchObservation = await branch.lookup("tools", declaration);
  if (!branchObservation.revision) throw new Error("expected observation");
  const trustedForCrossScope = create(trustedAdmission);
  await trustedForCrossScope.lookup("tools", declaration);
  await expect(
    trustedForCrossScope.publish(
      branchObservation.revision,
      objectFixture(branchObservation.revision, "f"),
    ),
  ).rejects.toThrow("cache publication identity mismatch");
});

test("concurrent identical publishers observe one winner and one duplicate", async () => {
  const refs = new MemoryRefs();
  const create = () =>
    new Cache({
      context,
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
    });
  const first = create();
  const second = create();
  const declaration = { key: "v1", path: "/cache/tools" } as const;
  const [firstObservation, secondObservation] = await Promise.all([
    first.lookup("tools", declaration),
    second.lookup("tools", declaration),
  ]);
  if (!firstObservation.revision || !secondObservation.revision) {
    throw new Error("expected observations");
  }
  const object = objectFixture(firstObservation.revision, "a");

  const results = await Promise.all([
    first.publish(firstObservation.revision, object),
    second.publish(secondObservation.revision, object),
  ]);

  expect(results.map(({ state }) => state).sort()).toEqual(["duplicate", "published"]);
  expect(refs.objects).toHaveLength(1);
});

test("a newer generation replaces a lower-generation winner of the missing-ref race", async () => {
  const refs = new MemoryRefs();
  const create = (generation: number) =>
    new Cache({
      context: { ...context, generation },
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
    });
  const older = create(1);
  const newer = create(2);
  const declaration = { key: "v1", path: "/cache/tools" } as const;
  const [olderLookup, newerLookup] = await Promise.all([
    older.lookup("tools", declaration),
    newer.lookup("tools", declaration),
  ]);
  if (!olderLookup.revision || !newerLookup.revision) throw new Error("expected observations");

  await older.publish(olderLookup.revision, objectFixture(olderLookup.revision, "a"));
  await expect(
    newer.publish(newerLookup.revision, objectFixture(newerLookup.revision, "b")),
  ).resolves.toMatchObject({ state: "published" });
  await expect(
    older.publish(olderLookup.revision, objectFixture(olderLookup.revision, "a")),
  ).rejects.toThrow("cache publication superseded");
  expect(JSON.parse(refs.objects.values().next().value!.text)).toMatchObject({
    generation: 2,
    objectDigest: objectFixture(newerLookup.revision, "b").digest,
  });
});

test("a successful cache snapshot is prepared as immutable content before its ref is published", async () => {
  const refs = new MemoryRefs();
  const events: string[] = [];
  const snapshots: NonNullable<ConstructorParameters<typeof Cache>[0]["snapshots"]> = {
    inspect: async () => "absent",
    capture: async ({ target, path }) => {
      events.push(`capture:${target}:${path}`);
      return {
        state: "ready" as const,
        archive: { path, bytes: 4096, digest: "a".repeat(64) },
        entryCount: 2,
        uniqueInodes: 2,
        fileCount: 1,
        byteCount: 12,
        diskBytes: 4108,
        maxDepth: 2,
        treeDigest: "e".repeat(64),
        durationMs: 7,
        estimatedCostUsd: 0.00001,
      };
    },
    upload: async ({ key, expected }) => {
      events.push(`manifest:${JSON.stringify(expected)}`);
      events.push(`upload:${key}`);
      return { state: "stored" as const, ...expected };
    },
    remove: async (path) => {
      events.push(`remove:${path}`);
    },
  };
  const create = () =>
    new Cache({
      context,
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
      snapshots,
    });
  const recorded = await create().record("tools", { key: "v1", path: "/cache/tools" });

  const prepared = await create().prepare(recorded.pending ? [recorded.pending] : []);

  expect(refs.writes).toEqual([]);
  expect(prepared).toHaveLength(1);
  expect(prepared[0]).toMatchObject({
    state: "ready",
    object: {
      archiveBytes: 4096,
      archiveDigest: "a".repeat(64),
      manifest: expect.stringMatching(/^\{"archiveDigest":"a{64}","byteCount":12,/),
    },
  });
  await create().commit(structuredClone(prepared));
  expect(refs.writes).toHaveLength(1);
  expect(events[0]).toMatch(/^capture:\/cache\/tools:\/cache\/\.runway-cache-[0-9a-f-]+\.sqsh$/);
  expect(events[1]).toMatch(/^manifest:\{"path":"\/cache\/\.runway-cache-/);
  expect(events[2]).toMatch(/^upload:content\/[0-9a-f]{64}\.sqsh$/);
  expect(events[3]).toMatch(/^remove:\/cache\/\.runway-cache-/);
});

test("cost admission rejects the conservative save bound before capture spends work", async () => {
  const refs = new MemoryRefs();
  let captures = 0;
  const snapshots: NonNullable<ConstructorParameters<typeof Cache>[0]["snapshots"]> = {
    inspect: async () => "absent",
    capture: async ({ path }) => {
      captures += 1;
      return {
        state: "ready",
        archive: { path, bytes: 1, digest: "a".repeat(64) },
        entryCount: 1,
        uniqueInodes: 1,
        fileCount: 1,
        byteCount: 1,
        diskBytes: 1,
        maxDepth: 1,
        treeDigest: "e".repeat(64),
        durationMs: 1,
      };
    },
    upload: async ({ expected }) => ({ state: "stored", ...expected }),
    remove: async () => {},
  };
  const create = () =>
    new Cache({
      context,
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current: async () => true,
      snapshots,
      meter: cacheMeter(1),
    });
  const recorded = await create().record("tools", {
    key: "v1",
    path: "/cache/tools",
    budget: { maxEstimatedCostUsd: 8 },
  });
  if (!recorded.pending) throw new Error("expected pending cache");

  await expect(create().prepare([recorded.pending])).resolves.toEqual([
    { state: "skipped", id: "tools", reason: "budget" },
  ]);
  expect(captures).toBe(0);
});

test("actual CAS retries change raw operation quantities without recording the admission bound", async () => {
  const refs = new FlakyRefs();
  const meter = cacheMeter();
  const cache = new Cache({
    context: { ...context, generation: 2 },
    refs,
    files: { inspect: async () => ({ type: "missing" as const }) },
    current: async () => true,
    meter,
  });
  const lookup = await cache.lookup("tools", { key: "v1", path: "/cache/tools" });
  if (!lookup.revision) throw new Error("expected revision");
  const beforeBound = structuredClone(meter.report().samples);

  meter.cacheBound({ maxBytes: 1, maxDurationMs: 1 });
  expect(meter.report().samples).toEqual(beforeBound);

  refs.objects.set(lookup.revision.ref, {
    etag: "older",
    text: JSON.stringify({ ...refRecord(lookup.revision), generation: 1 }),
  });
  refs.failures = 1;
  await cache.publish(lookup.revision, objectFixture(lookup.revision));

  expect(meter.report().samples).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "usage",
        source: "r2",
        unit: "class-a",
        quantity: 2,
        provenance: "derived",
      }),
      expect.objectContaining({
        type: "usage",
        source: "r2",
        unit: "class-b",
        quantity: 2,
        provenance: "derived",
      }),
    ]),
  );
});

test("unsafe, corrupt, over-budget, and concurrently deleted snapshots stay unreachable", async () => {
  const cases = [
    {
      name: "escaping link",
      skipped: "unsafe",
      reason: "unsafe",
    },
    {
      name: "special file",
      skipped: "unsafe",
      reason: "unsafe",
    },
    {
      name: "unsafe tree path",
      skipped: "unsafe",
      reason: "unsafe",
    },
    {
      name: "partial archive",
      change: { fileCount: 2 },
      reason: "corrupt",
    },
    {
      name: "archive bytes",
      budget: { maxBytes: 4095 },
      reason: "budget",
    },
    {
      name: "disk bytes",
      change: { diskBytes: 8192 },
      budget: { maxBytes: 4096 },
      reason: "budget",
    },
    {
      name: "duration",
      budget: { maxDurationMs: 6 },
      reason: "budget",
    },
    {
      name: "estimated cost",
      budget: { maxEstimatedCostUsd: 0.000009 },
      reason: "budget",
    },
    { name: "concurrent deletion", throws: true, reason: "unavailable" },
  ] as const;
  for (const example of cases) {
    const refs = new MemoryRefs();
    let uploads = 0;
    const snapshots: NonNullable<ConstructorParameters<typeof Cache>[0]["snapshots"]> = {
      inspect: async () => "absent",
      capture: async ({ path }) => {
        if ("throws" in example) throw new Error("tree entry disappeared during capture");
        if ("skipped" in example) {
          return { state: "skipped", reason: example.skipped } as const;
        }
        return {
          state: "ready",
          archive: { path, bytes: 4096, digest: "a".repeat(64) },
          entryCount: 1,
          uniqueInodes: 1,
          fileCount: 1,
          byteCount: 12,
          diskBytes: 4096,
          maxDepth: 1,
          treeDigest: "e".repeat(64),
          durationMs: 7,
          estimatedCostUsd: 0.00001,
          ...("change" in example ? example.change : {}),
        } as never;
      },
      upload: async ({ expected }) => {
        uploads += 1;
        return { state: "stored", ...expected };
      },
      remove: async () => {},
    };
    const create = () =>
      new Cache({
        context,
        refs,
        files: { inspect: async () => ({ type: "missing" as const }) },
        current: async () => true,
        snapshots,
      });
    const declaration = {
      key: "v1",
      path: "/cache/tools",
      ...("budget" in example ? { budget: example.budget } : {}),
    };
    const recorded = await create().record("tools", declaration);
    if (!recorded.pending) throw new Error("expected pending cache");

    await expect(
      create().prepare([structuredClone(recorded.pending)]),
      example.name,
    ).resolves.toEqual([{ state: "skipped", id: "tools", reason: example.reason }]);
    expect(uploads, example.name).toBe(0);
    expect(refs.writes, example.name).toEqual([]);
  }
});

test("pending file-key evidence survives mutable worktree changes without re-reading inputs", async () => {
  const refs = new MemoryRefs();
  let inspections = 0;
  const files = {
    inspect: async () => {
      inspections += 1;
      if (inspections > 1) throw new Error("post-command file inputs must not be re-read");
      return { type: "file" as const, bytes: new TextEncoder().encode("exact source") };
    },
  };
  const snapshots: NonNullable<ConstructorParameters<typeof Cache>[0]["snapshots"]> = {
    inspect: async () => "absent",
    capture: async ({ path }) => ({
      state: "ready",
      archive: { path, bytes: 4096, digest: "a".repeat(64) },
      ...treeEvidence,
      fileCount: 1,
      byteCount: 12,
      diskBytes: 4096,
      durationMs: 1,
      estimatedCostUsd: 0,
    }),
    upload: async ({ expected }) => ({ state: "stored", ...expected }),
    remove: async () => {},
  };
  const create = () => new Cache({ context, refs, files, current: async () => true, snapshots });
  const recorded = await create().record("tools", {
    key: { files: ["input.lock"] },
    path: "/cache/tools",
  });
  if (!recorded.pending) throw new Error("expected pending cache");

  await expect(create().prepare([structuredClone(recorded.pending)])).resolves.toMatchObject([
    { state: "ready" },
  ]);
  expect(inspections).toBe(1);
});

test("a CAS conflict or newer generation leaves uploaded content unreachable and diagnoses a skip", async () => {
  const refs = new MemoryRefs();
  const diagnostics: unknown[] = [];
  let uploads = 0;
  const meter = cacheMeter();
  const snapshots: NonNullable<ConstructorParameters<typeof Cache>[0]["snapshots"]> = {
    inspect: async () => "absent",
    capture: async ({ path }) => ({
      state: "ready",
      archive: { path, bytes: 4096, digest: "a".repeat(64) },
      ...treeEvidence,
      fileCount: 1,
      byteCount: 12,
      diskBytes: 4096,
      durationMs: 1,
      estimatedCostUsd: 0,
    }),
    upload: async ({ expected }) => {
      uploads += 1;
      return { state: "stored", ...expected };
    },
    remove: async () => {},
  };
  const create = (current = async () => true) =>
    new Cache({
      context,
      refs,
      files: { inspect: async () => ({ type: "missing" as const }) },
      current,
      snapshots,
      diagnose: (entry) => diagnostics.push(entry),
      meter,
    });
  const recorded = await create().record("tools", { key: "v1", path: "/cache/tools" });
  if (!recorded.pending) throw new Error("expected pending cache");
  const prepared = await create().prepare([structuredClone(recorded.pending)]);
  seed(refs, recorded.pending.revision, { etag: "concurrent", variant: "f" });
  const winner = refs.objects.get(recorded.pending.revision.ref)!.text;

  await create().commit(structuredClone(prepared));
  expect(refs.objects.get(recorded.pending.revision.ref)!.text).toBe(winner);
  expect(diagnostics).toContainEqual({ id: "tools", state: "skipped", reason: "conflict" });
  expect(uploads).toBe(1);
  expect(meter.report().samples).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "cache", state: "saved" })]),
  );

  refs.objects.delete(recorded.pending.revision.ref);
  const before = refs.writes.length;
  await create(async () => false).commit(structuredClone(prepared));
  expect(refs.writes).toHaveLength(before);
  expect(refs.objects.has(recorded.pending.revision.ref)).toBe(false);
});
