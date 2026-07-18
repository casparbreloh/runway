import { expect, test } from "vitest";

import {
  CloudflareCacheSnapshot,
  type CacheSnapshotProcess,
} from "../../src/internal/cache/snapshot.ts";

const archiveDigest = "95ff92053b19ae8bfea5ad1b1a8bb52b4d2e6793cba471f8588a864fdb53c0ed";
const treeDigest = "a2d1fbb19c1008738d296af40bbc731a6457fee5def4ee34b7c7e5045bd683df";

const summary = JSON.stringify({
  byteCount: 7,
  diskBytes: 4096,
  entryCount: 3,
  fileCount: 2,
  maxDepth: 2,
  schema: 2,
  treeDigest,
  uniqueInodes: 2,
});

class Process implements CacheSnapshotProcess {
  readonly commands: string[] = [];
  readonly events: string[] = [];
  readonly files = new Set<string>();
  readonly timeouts: number[] = [];
  outputs: string[] = [];

  async write(path: string, _contents: string): Promise<void> {
    this.files.add(path);
    this.events.push("write");
  }

  async execute(command: string, timeoutMs: number): Promise<{ readonly stdout: string }> {
    this.commands.push(command);
    this.events.push("execute");
    this.timeouts.push(timeoutMs);
    return { stdout: this.outputs.shift() ?? "" };
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.events.push("remove");
  }

  async rename(from: string, to: string): Promise<void> {
    this.events.push(`rename:${from}:${to}`);
  }

  async close(): Promise<void> {
    this.events.push("close");
  }
}

const archive = { bytes: 8192, digest: archiveDigest };

test("capture accepts only a fixed summary and removes its private helper on success", async () => {
  const process = new Process();
  process.outputs = [JSON.stringify({ ...JSON.parse(summary), archive })];
  const snapshots = new CloudflareCacheSnapshot({
    process: async () => process,
    transfer: {
      put: async () => ({ state: "stored", path: "/tmp/archive", ...archive }),
      get: async () => archive,
    },
  });

  await expect(
    snapshots.capture({
      target: "/workspace/cache",
      path: "/tmp/archive",
      budget: { maxBytes: 10_000, maxDurationMs: 20_000, maxEstimatedCostUsd: 1 },
    }),
  ).resolves.toMatchObject({
    state: "ready",
    archive: { path: "/tmp/archive", ...archive },
    treeDigest,
    entryCount: 3,
    uniqueInodes: 2,
    fileCount: 2,
    byteCount: 7,
  });
  expect(process.events).toEqual(["write", "execute", "remove", "close"]);
  expect(process.commands[0]).toContain("-- /usr/local/bin/node ");
  expect(process.commands[0]).not.toContain("python");
  expect(process.timeouts).toEqual([20_000]);
  expect(process.files).toEqual(new Set());
});

test.each([
  ["unknown field", { ...JSON.parse(summary), extra: 1 }],
  ["bad digest", { ...JSON.parse(summary), treeDigest: "wrong" }],
  ["fractional count", { ...JSON.parse(summary), entryCount: 1.5 }],
  ["too many entries", { ...JSON.parse(summary), entryCount: 1_000_001 }],
  ["more files than entries", { ...JSON.parse(summary), fileCount: 4 }],
  ["excess depth", { ...JSON.parse(summary), maxDepth: 257 }],
  ["empty with counts", { ...JSON.parse(summary), entryCount: 0 }],
  ["populated without inodes", { ...JSON.parse(summary), uniqueInodes: 0 }],
  ["populated without depth", { ...JSON.parse(summary), maxDepth: 0 }],
])("rejects hostile helper summaries: %s", async (_name, value) => {
  const process = new Process();
  process.outputs = [JSON.stringify({ ...value, archive })];
  const snapshots = new CloudflareCacheSnapshot({
    process: async () => process,
    transfer: {
      put: async () => ({ state: "stored", path: "/tmp/archive", ...archive }),
      get: async () => archive,
    },
  });

  await expect(
    snapshots.capture({
      target: "/workspace/cache",
      path: "/tmp/archive",
      budget: { maxBytes: 10_000, maxDurationMs: 20_000, maxEstimatedCostUsd: 1 },
    }),
  ).resolves.toEqual({ state: "skipped", reason: "corrupt" });
  expect(process.files).toEqual(new Set());
  expect(process.events.at(-1)).toBe("close");
});

test("restore verifies the archive before its isolated copy and cleans every failure", async () => {
  const process = new Process();
  process.outputs = [summary];
  const events: string[] = [];
  const snapshots = new CloudflareCacheSnapshot({
    process: async () => process,
    transfer: {
      put: async () => ({ state: "stored", path: "/tmp/archive", ...archive }),
      get: async ({ expected }) => {
        events.push("download");
        return expected;
      },
    },
  });

  await expect(
    snapshots.stage({
      object: {
        digest: treeDigest,
        archiveBytes: archive.bytes,
        archiveDigest: archive.digest,
        byteCount: 7,
        fileCount: 2,
        treeDigest,
        entryCount: 3,
        uniqueInodes: 2,
        maxDepth: 2,
      },
      path: "/workspace/.cache.staging",
      target: "/workspace/cache",
      budget: { maxBytes: 10_000, maxDurationMs: 20_000, maxEstimatedCostUsd: 1 },
    }),
  ).resolves.toMatchObject({ state: "ready", treeDigest, byteCount: 7, fileCount: 2 });
  expect(events).toEqual(["download"]);
  expect(process.events).toEqual(["write", "execute", "remove", "close", "remove", "close"]);
  expect(process.timeouts).toEqual([20_000]);
  expect(process.files).toEqual(new Set());
});
