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
import { env, execPath, platform } from "node:process";
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

const withHelper = async <T>(
  work: (directory: string, helper: string) => Promise<T>,
): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), "runway-cache-helper-"));
  const helper = join(directory, "helper.cjs");
  try {
    await writeFile(helper, CACHE_SNAPSHOT_HELPER, { mode: 0o700 });
    return await work(directory, helper);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const scan = async (helper: string, path: string, maxBytes = 1_000_000): Promise<unknown> => {
  const { stdout } = await execute(execPath, [helper, "scan", path, String(maxBytes)], {
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
      await writeFile(Buffer.concat([Buffer.from(root), Buffer.from([47, 255])]), "raw");
    } else {
      await writeFile(join(root, "raw\nname"), "raw");
    }

    const first = await scan(helper, root);
    const second = await scan(helper, root);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schema: 2,
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
    await expect(execute(execPath, [helper, "scan", escaping, "1000"])).rejects.toThrow();

    const special = join(directory, "special");
    await mkdir(special);
    await execute("mkfifo", [join(special, "fifo")]);
    await expect(execute(execPath, [helper, "scan", special, "1000"])).rejects.toThrow();

    const oversized = join(directory, "oversized");
    await mkdir(oversized);
    await writeFile(join(oversized, "payload"), "too large");
    await expect(execute(execPath, [helper, "scan", oversized, "2"])).rejects.toThrow();
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
    const map = Buffer.alloc(4);
    const footer = Buffer.alloc(60);
    Buffer.from("52554e574159484c494e4b4d41500000", "hex").copy(footer);
    footer.writeUInt32BE(2, 16);
    footer.writeBigUInt64BE(BigInt(map.length), 20);
    createHash("sha256").update(map).digest().copy(footer, 28);
    const encoded = Buffer.concat([valid.subarray(0, 224), map, footer]);
    const archive = join(directory, "archive.sqsh");
    await writeFile(archive, encoded);
    const { stdout } = await execute(execPath, [helper, "preflight", archive, "1000"], {
      encoding: "utf8",
    });
    expect(JSON.parse(stdout)).toEqual({
      bytes: encoded.byteLength,
      digest: createHash("sha256").update(encoded).digest("hex"),
    });

    for (const [name, mutate] of [
      ["compression", (bytes: Buffer) => bytes.writeUInt16LE(1, 20)],
      ["physical bytes", (bytes: Buffer) => bytes.writeBigUInt64LE(257n, 40)],
      ["table bounds", (bytes: Buffer) => bytes.writeBigUInt64LE(225n, 48)],
      ["root inode", (bytes: Buffer) => bytes.writeBigUInt64LE(8192n, 32)],
    ] as const) {
      const hostile = Buffer.from(encoded);
      mutate(hostile);
      const path = join(directory, `${name}.sqsh`);
      await writeFile(path, hostile);
      await expect(execute(execPath, [helper, "preflight", path, "1000"]), name).rejects.toThrow();
    }
  });
});

test("the owned helper requires one canonical authenticated hardlink trailer at exact EOF", async () => {
  await withHelper(async (directory, helper) => {
    const base = Buffer.alloc(224);
    base.writeUInt32LE(0x73717368, 0);
    base.writeUInt32LE(1, 4);
    base.writeUInt32LE(131_072, 12);
    base.writeUInt16LE(6, 20);
    base.writeUInt16LE(17, 22);
    base.writeUInt16LE(1, 26);
    base.writeUInt16LE(4, 28);
    base.writeBigUInt64LE(224n, 40);
    base.writeBigUInt64LE(192n, 48);
    base.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 56);
    base.writeBigUInt64LE(128n, 64);
    base.writeBigUInt64LE(160n, 72);
    base.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 80);
    base.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 88);
    const path = Buffer.from("a");
    const other = Buffer.from("b");
    const map = Buffer.alloc(4 + 4 + 4 + path.length + 4 + other.length);
    let offset = 0;
    map.writeUInt32BE(1, offset);
    offset += 4;
    map.writeUInt32BE(2, offset);
    offset += 4;
    map.writeUInt32BE(path.length, offset);
    offset += 4;
    path.copy(map, offset);
    offset += path.length;
    map.writeUInt32BE(other.length, offset);
    offset += 4;
    other.copy(map, offset);
    const footer = Buffer.alloc(60);
    Buffer.from("52554e574159484c494e4b4d41500000", "hex").copy(footer);
    footer.writeUInt32BE(2, 16);
    footer.writeBigUInt64BE(BigInt(map.length), 20);
    createHash("sha256").update(map).digest().copy(footer, 28);
    const valid = Buffer.concat([base, map, footer]);

    const cases = new Map<string, Buffer>([
      ["missing", base],
      ["trailing", Buffer.concat([valid, Buffer.from([0])])],
      ["digest", Buffer.from(valid)],
      ["length", Buffer.from(valid)],
      ["duplicate", Buffer.from(valid)],
    ]);
    const badDigest = cases.get("digest")!;
    badDigest.writeUInt8(badDigest.readUInt8(valid.length - 1) ^ 1, valid.length - 1);
    cases.get("length")!.writeBigUInt64BE(BigInt(map.length + 1), valid.length - 40);
    const duplicateMap = Buffer.from(map);
    duplicateMap[duplicateMap.length - 1] = 0x61;
    const duplicate = cases.get("duplicate")!;
    duplicateMap.copy(duplicate, base.length);
    createHash("sha256")
      .update(duplicateMap)
      .digest()
      .copy(duplicate, duplicate.length - 32);

    for (const [name, bytes] of cases) {
      const archive = join(directory, `${name}.sqsh`);
      await writeFile(archive, bytes);
      await expect(
        execute(execPath, [helper, "preflight", archive, "1000"]),
        name,
      ).rejects.toThrow();
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
    const { stdout } = await execute(execPath, [helper, "copy", source, staging, "1000000"], {
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

    await expect(execute(execPath, [helper, "copy", source, staging, "1000000"])).rejects.toThrow();
    const limited = join(directory, "limited");
    await expect(execute(execPath, [helper, "copy", source, limited, "2"])).rejects.toThrow();
    await expect(lstat(limited)).rejects.toThrow();

    const escaping = join(directory, "escaping-source");
    const escapedStaging = join(directory, "escaped-staging");
    await mkdir(escaping);
    await symlink("../outside", join(escaping, "link"));
    await expect(
      execute(execPath, [helper, "copy", escaping, escapedStaging, "1000"]),
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
      budget: { maxBytes: 10_000, maxDurationMs: 20_000, maxEstimatedCostUsd: 1 },
    }),
  ).resolves.toMatchObject({ state: "ready", treeDigest, byteCount: 7, fileCount: 2 });
  expect(events).toEqual(["download"]);
  expect(process.events).toEqual(["write", "execute", "remove", "close", "remove", "close"]);
  expect(process.timeouts).toEqual([20_000]);
  expect(process.files).toEqual(new Set());
});

test.runIf(env.RUNWAY_EXACT_IMAGE_CACHE_SNAPSHOT === "1")(
  "the exact pinned privileged image captures and restores arbitrary hardlink groups",
  async () => {
    await withHelper(async (directory) => {
      const script = String.raw`
const child = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const helper = "/evidence/helper.cjs";
const source = "/tmp/source";
const archive = "/tmp/cache.sqsh";
const mount = "/tmp/mount";
const staging = "/tmp/staging";
fs.mkdirSync(source + "/nested", { recursive: true });
fs.writeFileSync(source + "/nested/one", "one");
fs.linkSync(source + "/nested/one", source + "/one-alias");
fs.writeFileSync(source + "/two", "two");
fs.linkSync(source + "/two", source + "/two-alias-a");
fs.linkSync(source + "/two", source + "/two-alias-b");
fs.writeFileSync(source + "/duplicate-content-nonlink", "one");
const rawOne = Buffer.concat([Buffer.from(source + "/"), Buffer.from([255])]);
const rawTwo = Buffer.concat([Buffer.from(source + "/"), Buffer.from([254])]);
fs.writeFileSync(rawOne, "raw");
fs.linkSync(rawOne, rawTwo);
const run = (args) => {
  const result = child.spawnSync("/usr/local/bin/node", [helper, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "helper failed");
  return JSON.parse(result.stdout);
};
const captured = run(["capture", source, archive, mount, "1000000"]);
if (!captured.archive) throw new Error("capture failed: " + JSON.stringify(captured));
const restored = run(["restore", archive, mount, staging, "1000000", JSON.stringify({ ...captured, diskBytes: 0, archive: undefined }), String(captured.archive.bytes), captured.archive.digest]);
const inode = (path) => fs.lstatSync(path).ino;
if (restored.treeDigest !== captured.treeDigest) throw new Error("evidence mismatch");
if (inode(staging + "/nested/one") !== inode(staging + "/one-alias")) throw new Error("group one lost");
if (inode(staging + "/two") !== inode(staging + "/two-alias-a") || inode(staging + "/two") !== inode(staging + "/two-alias-b")) throw new Error("group two lost");
if (inode(staging + "/nested/one") === inode(staging + "/duplicate-content-nonlink")) throw new Error("nonlink collapsed");
if (fs.lstatSync(Buffer.concat([Buffer.from(staging + "/"), Buffer.from([255])])).ino !== fs.lstatSync(Buffer.concat([Buffer.from(staging + "/"), Buffer.from([254])])).ino) throw new Error("raw group lost");
const original = fs.readFileSync(archive);
const squashfsBytes = Number(original.readBigUInt64LE(40));
const encodeMap = (groups) => {
  const fields = [];
  const count = Buffer.alloc(4);
  count.writeUInt32BE(groups.length);
  fields.push(count);
  for (const group of groups.map((paths) => paths.map(Buffer.from).sort(Buffer.compare)).sort((left, right) => Buffer.compare(left[0], right[0]))) {
    const members = Buffer.alloc(4);
    members.writeUInt32BE(group.length);
    fields.push(members);
    for (const path of group) {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(path.length);
      fields.push(length, path);
    }
  }
  return Buffer.concat(fields);
};
const hostile = [
  [],
  [["missing-one", "nested/one"]],
  [["nested", "one-alias"]],
  [["duplicate-content-nonlink", "two"]],
];
for (const [index, groups] of hostile.entries()) {
  const map = encodeMap(groups);
  const footer = Buffer.alloc(60);
  Buffer.from("52554e574159484c494e4b4d41500000", "hex").copy(footer);
  footer.writeUInt32BE(2, 16);
  footer.writeBigUInt64BE(BigInt(map.length), 20);
  crypto.createHash("sha256").update(map).digest().copy(footer, 28);
  const hostileArchive = "/tmp/hostile-" + index + ".sqsh";
  fs.writeFileSync(hostileArchive, Buffer.concat([original.subarray(0, squashfsBytes), map, footer]));
  const hostileMount = "/tmp/hostile-mount-" + index;
  const result = child.spawnSync("/usr/local/bin/node", [helper, "mounted-scan", hostileArchive, hostileMount, "1000000"]);
  if (result.status === 0) throw new Error("hostile map accepted: " + index);
  if (fs.existsSync(hostileMount)) throw new Error("hostile mount retained: " + index);
}
process.stdout.write(JSON.stringify({ archiveBytes: captured.archive.bytes, entryCount: captured.entryCount }));
`;
      const { stdout } = await execute(
        "docker",
        [
          "run",
          "--rm",
          "--privileged",
          "--platform",
          "linux/amd64",
          "--entrypoint",
          "/usr/local/bin/node",
          "--volume",
          `${directory}:/evidence:ro`,
          "docker.io/cloudflare/sandbox@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042",
          "-e",
          script,
        ],
        { encoding: "utf8", timeout: 180_000 },
      );
      expect(JSON.parse(stdout)).toMatchObject({ entryCount: 9 });
    });
  },
  180_000,
);
