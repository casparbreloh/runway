import { expect, test } from "vitest";

import { Cache } from "../src/cache.ts";

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

interface ObservedRevision {
  readonly cacheIdDigest: string;
  readonly declarationDigest: string;
  readonly generation: number;
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

const refRecord = (
  revision: ObservedRevision,
  objectDigest = "a".repeat(64),
): Record<string, unknown> => ({
  cacheIdDigest: revision.cacheIdDigest,
  declarationDigest: revision.declarationDigest,
  generation: revision.generation,
  keyDigest: revision.keyDigest,
  objectDigest,
  platformDigest: revision.platformDigest,
  repositoryDigest: revision.repositoryDigest,
  schema: revision.schema,
  scopeDigest: revision.scopeDigest,
});

const seed = (
  refs: MemoryRefs,
  revision: ObservedRevision,
  options: { readonly etag?: string; readonly objectDigest?: string } = {},
): void => {
  refs.objects.set(revision.ref, {
    etag: options.etag ?? "version-1",
    text: JSON.stringify(refRecord(revision, options.objectDigest)),
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
    schema: 1,
    os: "linux",
    architecture: "x86_64",
    imageDigest: `sha256:${"1".repeat(64)}`,
    runnerAbi: "runway-1",
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
    key: { files: ["missing.lock", "pnpm-lock.yaml"], salt: "linux" },
    path: "/cache/dependencies",
  });
  const filesTwo = await create().lookup("dependencies", {
    key: { files: ["missing.lock", "pnpm-lock.yaml"], salt: "linux" },
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
    key: { files: ["missing.lock", "pnpm-lock.yaml"], salt: "linux" },
    path: "/cache/dependencies",
  });
  files.set("missing.lock", new Uint8Array());
  const present = await create().lookup("dependencies", {
    key: { files: ["missing.lock", "pnpm-lock.yaml"], salt: "linux" },
    path: "/cache/dependencies",
  });

  expect(revisionOf(changed).ref).not.toBe(filesOneRevision.ref);
  expect(revisionOf(present).ref).not.toBe(revisionOf(changed).ref);
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
              stage: async ({ object, path }: { object: { digest: string }; path: string }) => {
                events.push(`stage:${object.digest}:${path}`);
                return { state: "ready" as const, bytes: 37, digest: object.digest };
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
  seed(refs, miss.revision, { objectDigest: "c".repeat(64) });

  await expect(create().restore("tree", declaration)).resolves.toEqual({ state: "hit", bytes: 37 });
  expect(events[0]).toBe("inspect:/cache/tree:absent");
  expect(events[1]).toMatch(/^stage:c{64}:\/cache\/\.runway-cache-[0-9a-f-]+$/);
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
  seed(refs, miss.revision, { objectDigest: "d".repeat(64) });
  let target = "empty" as "empty" | "absent";
  const removals: string[] = [];
  const cache = new Cache({
    context,
    refs,
    files: { inspect: async () => ({ type: "missing" as const }) },
    current: async () => true,
    restore: {
      inspect: async () => target,
      stage: async ({ object }) => ({ state: "ready", bytes: 1, digest: object.digest }),
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
  seed(refs, miss.revision, { objectDigest: "e".repeat(64) });
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
    ["runway:owned", { key: "valid", path: "/cache/x" }],
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
  seed(refs, absent.revision, { objectDigest: "b".repeat(64) });

  await expect(create().lookup("tools", declaration)).resolves.toMatchObject({
    state: "hit",
    object: { digest: "b".repeat(64) },
    revision: { etag: "version-1" },
  });
  const variants = [
    { ...context.platform, schema: 2 },
    { ...context.platform, os: "freebsd" },
    { ...context.platform, architecture: "aarch64" },
    { ...context.platform, imageDigest: `sha256:${"2".repeat(64)}` },
    { ...context.platform, runnerAbi: "runway-2" },
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
  seed(refs, fallback.revision, { etag: "branch-version", objectDigest: "b".repeat(64) });
  const readsBeforeOwnHit = refs.reads.length;

  await expect(branchCache.lookup("tools", declaration)).resolves.toMatchObject({
    state: "hit",
    object: { digest: "b".repeat(64) },
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
    trustedCache.publish(missing.revision, { digest: "a".repeat(64) }),
  ).resolves.toMatchObject({ state: "published" });
  const hit = await trustedCache.lookup("tools", declaration);
  if (!hit.revision) throw new Error("expected observation");
  await expect(
    trustedCache.publish(hit.revision, { digest: "b".repeat(64) }),
  ).resolves.toMatchObject({ state: "published" });

  const branchCache = create({
    type: "push",
    ref: "refs/heads/feature",
    defaultRef: "refs/heads/main",
  });
  const fallback = await branchCache.lookup("tools", declaration);
  if (!fallback.revision) throw new Error("expected observation");
  expect(fallback).toMatchObject({ state: "hit", object: { digest: "b".repeat(64) } });
  await expect(
    branchCache.publish(fallback.revision, { digest: "c".repeat(64) }),
  ).resolves.toMatchObject({ state: "published" });

  expect(refs.writes).toEqual([
    { key: missing.revision.ref, onlyIf: { etagDoesNotMatch: "*" } },
    { key: hit.revision.ref, onlyIf: { etagMatches: "version-1" } },
    { key: fallback.revision.ref, onlyIf: { etagDoesNotMatch: "*" } },
  ]);
  expect(JSON.parse(refs.objects.get(hit.revision.ref)!.text)).toMatchObject({
    objectDigest: "b".repeat(64),
  });
  expect(JSON.parse(refs.objects.get(fallback.revision.ref)!.text)).toMatchObject({
    objectDigest: "c".repeat(64),
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
    create(trustedAdmission).publish(missing.revision, { digest: "a".repeat(64) }),
  ).rejects.toThrow("blind cache publication");
  await trusted.publish(missing.revision, { digest: "a".repeat(64) });
  const observed = await trusted.lookup("tools", declaration);
  if (!observed.revision) throw new Error("expected observation");
  seed(refs, observed.revision, { etag: "external-version", objectDigest: "b".repeat(64) });
  await expect(trusted.publish(observed.revision, { digest: "c".repeat(64) })).rejects.toThrow(
    "cache publication stale",
  );

  const superseded = create(trustedAdmission, async () => false);
  const supersededObservation = await superseded.lookup("tools", declaration);
  if (!supersededObservation.revision) throw new Error("expected observation");
  const writesBeforeSuperseded = refs.writes.length;
  await expect(
    superseded.publish(supersededObservation.revision, { digest: "d".repeat(64) }),
  ).rejects.toThrow("cache publication superseded");
  expect(refs.writes).toHaveLength(writesBeforeSuperseded);

  refs.objects.delete(missing.revision.ref);
  const older = create(trustedAdmission, async () => true, 1);
  const olderObservation = await older.lookup("tools", declaration);
  if (!olderObservation.revision) throw new Error("expected observation");
  seed(refs, { ...olderObservation.revision, generation: 2 }, { objectDigest: "e".repeat(64) });
  await expect(
    older.publish(olderObservation.revision, { digest: "e".repeat(64) }),
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
    trustedForCrossScope.publish(branchObservation.revision, { digest: "f".repeat(64) }),
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
  const object = { digest: "a".repeat(64) } as const;

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

  await older.publish(olderLookup.revision, { digest: "a".repeat(64) });
  await expect(
    newer.publish(newerLookup.revision, { digest: "b".repeat(64) }),
  ).resolves.toMatchObject({ state: "published" });
  await expect(older.publish(olderLookup.revision, { digest: "a".repeat(64) })).rejects.toThrow(
    "cache publication superseded",
  );
  expect(JSON.parse(refs.objects.values().next().value!.text)).toMatchObject({
    generation: 2,
    objectDigest: "b".repeat(64),
  });
});
