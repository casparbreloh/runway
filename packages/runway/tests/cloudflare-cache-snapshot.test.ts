import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  link,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import {
  CACHE_SNAPSHOT_HELPER,
  CloudflareCacheSnapshot,
  type CacheSnapshotProcess,
} from "../src/cloudflare/cache-snapshot.ts";

const execute = promisify(execFile);
const archiveDigest = "95ff92053b19ae8bfea5ad1b1a8bb52b4d2e6793cba471f8588a864fdb53c0ed";
const treeDigest = "a2d1fbb19c1008738d296af40bbc731a6457fee5def4ee34b7c7e5045bd683df";

const summary = JSON.stringify({
  byteCount: 7,
  diskBytes: 4096,
  entryCount: 3,
  fileCount: 2,
  maxDepth: 2,
  schema: 1,
  treeDigest,
  uniqueInodes: 2,
});

class Process implements CacheSnapshotProcess {
  readonly events: string[] = [];
  readonly files = new Set<string>();
  readonly timeouts: number[] = [];
  outputs: string[] = [];

  async write(path: string, _contents: string): Promise<void> {
    this.files.add(path);
    this.events.push("write");
  }

  async execute(_command: string, timeoutMs: number): Promise<{ readonly stdout: string }> {
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

const withHelper = async <T>(
  work: (directory: string, helper: string) => Promise<T>,
): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), "runway-cache-helper-"));
  const helper = join(directory, "helper.py");
  try {
    await writeFile(helper, CACHE_SNAPSHOT_HELPER, { mode: 0o700 });
    return await work(directory, helper);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const scan = async (helper: string, path: string, maxBytes = 1_000_000): Promise<unknown> => {
  const { stdout } = await execute("python3", [helper, "scan", path, String(maxBytes)], {
    encoding: "utf8",
  });
  return JSON.parse(stdout);
};

test("the owned helper scans raw-byte trees deterministically and retains hardlink identity", async () => {
  await withHelper(async (directory, helper) => {
    const root = join(directory, "tree");
    await mkdir(join(root, "nested"), { recursive: true });
    const content = join(root, "nested", "content");
    await writeFile(content, "payload");
    await link(content, join(root, "hardlink"));
    await symlink("nested/content", join(root, "internal-link"));
    if (platform === "linux") {
      await execute("python3", [
        "-c",
        "import os,sys; p=os.fsencode(sys.argv[1])+b'/\\xff'; f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.write(f,b'raw'); os.close(f)",
        root,
      ]);
    } else {
      await writeFile(join(root, "raw\nname"), "raw");
    }

    const first = await scan(helper, root);
    const second = await scan(helper, root);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schema: 1,
      byteCount: 10,
      entryCount: 5,
      fileCount: 3,
      uniqueInodes: 4,
      maxDepth: 2,
    });
    expect(first).toHaveProperty("treeDigest", expect.stringMatching(/^[0-9a-f]{64}$/));
  });
});

test("the owned helper rejects escaping links, special files, and expanded-byte quotas", async () => {
  await withHelper(async (directory, helper) => {
    const escaping = join(directory, "escaping");
    await mkdir(escaping);
    await symlink("../outside", join(escaping, "link"));
    await expect(execute("python3", [helper, "scan", escaping, "1000"])).rejects.toThrow();

    const special = join(directory, "special");
    await mkdir(special);
    await execute("mkfifo", [join(special, "fifo")]);
    await expect(execute("python3", [helper, "scan", special, "1000"])).rejects.toThrow();

    const oversized = join(directory, "oversized");
    await mkdir(oversized);
    await writeFile(join(oversized, "payload"), "too large");
    await expect(execute("python3", [helper, "scan", oversized, "2"])).rejects.toThrow();
  });
});

test("the owned helper preflights fixed v4 zstd geometry, physical bytes, and table bounds", async () => {
  await withHelper(async (directory, helper) => {
    const valid = Buffer.alloc(256);
    valid.writeUInt32LE(0x73717368, 0);
    valid.writeUInt32LE(1, 4);
    valid.writeUInt32LE(131_072, 12);
    valid.writeUInt16LE(6, 20);
    valid.writeUInt16LE(17, 22);
    valid.writeUInt16LE(1, 26);
    valid.writeUInt16LE(4, 28);
    valid.writeBigUInt64LE(224n, 40);
    valid.writeBigUInt64LE(192n, 48);
    valid.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 56);
    valid.writeBigUInt64LE(128n, 64);
    valid.writeBigUInt64LE(160n, 72);
    valid.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 80);
    valid.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 88);
    const archive = join(directory, "archive.sqsh");
    await writeFile(archive, valid);
    const { stdout } = await execute("python3", [helper, "preflight", archive, "1000"], {
      encoding: "utf8",
    });
    expect(JSON.parse(stdout)).toEqual({
      bytes: valid.byteLength,
      digest: createHash("sha256").update(valid).digest("hex"),
    });

    for (const [name, mutate] of [
      ["compression", (bytes: Buffer) => bytes.writeUInt16LE(1, 20)],
      ["physical bytes", (bytes: Buffer) => bytes.writeBigUInt64LE(257n, 40)],
      ["table bounds", (bytes: Buffer) => bytes.writeBigUInt64LE(225n, 48)],
      ["root inode", (bytes: Buffer) => bytes.writeBigUInt64LE(8192n, 32)],
    ] as const) {
      const hostile = Buffer.from(valid);
      mutate(hostile);
      const path = join(directory, `${name}.sqsh`);
      await writeFile(path, hostile);
      await expect(execute("python3", [helper, "preflight", path, "1000"]), name).rejects.toThrow();
    }
  });
});

test("the owned helper copies fd-relative into absent staging, preserves hardlinks, links last, and rescans exact evidence", async () => {
  await withHelper(async (directory, helper) => {
    const source = join(directory, "source");
    const staging = join(directory, "staging");
    await mkdir(join(source, "nested"), { recursive: true });
    const content = join(source, "nested", "content");
    await writeFile(content, "payload");
    await link(content, join(source, "hardlink"));
    await symlink("nested/content", join(source, "internal-link"));

    const sourceSummary = await scan(helper, source);
    const { stdout } = await execute("python3", [helper, "copy", source, staging, "1000000"], {
      encoding: "utf8",
    });
    expect(JSON.parse(stdout)).toMatchObject({
      treeDigest: (sourceSummary as Record<string, unknown>).treeDigest,
      entryCount: 4,
      fileCount: 2,
      byteCount: 7,
    });
    expect(await readFile(join(staging, "internal-link"), "utf8")).toBe("payload");
    expect(await readlink(join(staging, "internal-link"))).toBe("nested/content");
    expect((await lstat(join(staging, "hardlink"))).ino).toBe(
      (await lstat(join(staging, "nested", "content"))).ino,
    );
    expect(await scan(helper, staging)).toMatchObject({
      treeDigest: (sourceSummary as Record<string, unknown>).treeDigest,
      entryCount: 4,
      fileCount: 2,
      byteCount: 7,
    });

    await expect(
      execute("python3", [helper, "copy", source, staging, "1000000"]),
    ).rejects.toThrow();
    const limited = join(directory, "limited");
    await expect(execute("python3", [helper, "copy", source, limited, "2"])).rejects.toThrow();
    await expect(lstat(limited)).rejects.toThrow();

    const escaping = join(directory, "escaping-source");
    const escapedStaging = join(directory, "escaped-staging");
    await mkdir(escaping);
    await symlink("../outside", join(escaping, "link"));
    await expect(
      execute("python3", [helper, "copy", escaping, escapedStaging, "1000"]),
    ).rejects.toThrow();
    await expect(lstat(escapedStaging)).rejects.toThrow();
  });
});

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
      budget: { maxBytes: 10_000, maxDurationMs: 20_000, maxEstimatedCostUsd: 1 },
    }),
  ).resolves.toMatchObject({ state: "ready", treeDigest, byteCount: 7, fileCount: 2 });
  expect(events).toEqual(["download"]);
  expect(process.events).toEqual(["write", "execute", "remove", "close", "remove", "close"]);
  expect(process.timeouts).toEqual([20_000]);
  expect(process.files).toEqual(new Set());
});
