import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import {
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

class DockerProcess implements CacheSnapshotProcess {
  readonly errors: string[] = [];

  constructor(
    private readonly container: string,
    private readonly directory: string,
  ) {}

  async write(path: string, contents: string): Promise<void> {
    const source = join(this.directory, randomUUID());
    try {
      await writeFile(source, contents, { mode: 0o700 });
      await execute("docker", ["cp", source, `${this.container}:${path}`]);
    } finally {
      await rm(source, { force: true });
    }
  }

  async execute(command: string, timeoutMs: number): Promise<{ readonly stdout: string }> {
    try {
      const { stdout } = await execute(
        "docker",
        [
          "exec",
          "--env",
          "PATH=/tmp/runway-test-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          this.container,
          "/bin/sh",
          "-c",
          command,
        ],
        { encoding: "utf8", timeout: timeoutMs + 5_000 },
      );
      return { stdout };
    } catch (error) {
      this.errors.push(String(error));
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    await execute("docker", ["exec", this.container, "rm", "-rf", "--", path]);
  }

  async rename(from: string, to: string): Promise<void> {
    await execute("docker", ["exec", this.container, "mv", "--", from, to]);
  }

  async close(): Promise<void> {}
}

const inContainer = async (container: string, script: string): Promise<string> => {
  const { stdout } = await execute(
    "docker",
    ["exec", container, "/usr/local/bin/node", "-e", script],
    { encoding: "utf8", timeout: 30_000 },
  );
  return stdout;
};

test.runIf(env.RUNWAY_EXACT_IMAGE_CACHE_SNAPSHOT === "1")(
  "the exact pinned image safely captures and restores hardlinks through the snapshot adapter",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "runway-cache-snapshot-"));
    const image =
      "docker.io/cloudflare/sandbox@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042";
    const { stdout } = await execute(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--privileged",
        "--memory",
        "1g",
        "--platform",
        "linux/amd64",
        "--entrypoint",
        "/bin/sh",
        image,
        "-lc",
        "sleep infinity",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    const container = stdout.trim();
    try {
      await inContainer(
        container,
        String.raw`
const fs = require("node:fs");
const source = "/tmp/source";
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
`,
      );
      const process = new DockerProcess(container, directory);
      let transferSource = "/tmp/cache.sqsh";
      const snapshots = new CloudflareCacheSnapshot({
        process: async () => process,
        transfer: {
          put: async ({ path }) => ({ state: "stored", path, bytes: 0, digest: "" }),
          get: async ({ path, expected }) => {
            await inContainer(
              container,
              `require("node:fs").copyFileSync(${JSON.stringify(transferSource)}, ${JSON.stringify(path)})`,
            );
            return expected;
          },
        },
      });
      const budget = { maxBytes: 1_000_000, maxDurationMs: 120_000 };
      const captured = await snapshots.capture({
        target: "/tmp/source",
        path: "/tmp/cache.sqsh",
        budget,
      });
      if (captured.state !== "ready") throw new Error(process.errors.join("\n"));
      expect(captured).toMatchObject({ state: "ready", entryCount: 9, fileCount: 8 });
      const object = (archive = captured.archive) => ({
        digest: captured.treeDigest,
        archiveBytes: archive.bytes,
        archiveDigest: archive.digest,
        byteCount: captured.byteCount,
        fileCount: captured.fileCount,
        treeDigest: captured.treeDigest,
        entryCount: captured.entryCount,
        uniqueInodes: captured.uniqueInodes,
        maxDepth: captured.maxDepth,
      });

      const restored = await snapshots.stage({
        object: object(),
        path: "/tmp/restored",
        budget,
      });
      expect(restored).toMatchObject({ state: "ready", treeDigest: captured.treeDigest });
      await expect(
        inContainer(
          container,
          String.raw`
const fs = require("node:fs");
const root = "/tmp/restored";
const inode = (path) => fs.lstatSync(path).ino;
if (inode(root + "/nested/one") !== inode(root + "/one-alias")) throw new Error("group one lost");
if (inode(root + "/two") !== inode(root + "/two-alias-a") || inode(root + "/two") !== inode(root + "/two-alias-b")) throw new Error("group two lost");
if (inode(root + "/nested/one") === inode(root + "/duplicate-content-nonlink")) throw new Error("nonlink collapsed");
if (fs.lstatSync(Buffer.concat([Buffer.from(root + "/"), Buffer.from([255])])).ino !== fs.lstatSync(Buffer.concat([Buffer.from(root + "/"), Buffer.from([254])])).ino) throw new Error("raw group lost");
if (fs.readFileSync(root + "/nested/one", "utf8") !== "one") throw new Error("content changed");
`,
        ),
      ).resolves.toBe("");

      await inContainer(
        container,
        `const fs=require("node:fs"); fs.mkdirSync("/tmp/escaping"); fs.symlinkSync("../outside", "/tmp/escaping/link"); fs.mkdirSync("/tmp/special"); require("node:child_process").execFileSync("mkfifo", ["/tmp/special/fifo"]); fs.mkdirSync("/tmp/oversized"); fs.writeFileSync("/tmp/oversized/payload", "too large")`,
      );
      await expect(
        snapshots.capture({ target: "/tmp/escaping", path: "/tmp/escaping.sqsh", budget }),
      ).resolves.toEqual({ state: "skipped", reason: "unsafe" });
      await expect(
        snapshots.capture({ target: "/tmp/special", path: "/tmp/special.sqsh", budget }),
      ).resolves.toEqual({ state: "skipped", reason: "unsafe" });
      await expect(
        snapshots.capture({
          target: "/tmp/oversized",
          path: "/tmp/oversized.sqsh",
          budget: { ...budget, maxBytes: 2 },
        }),
      ).resolves.toEqual({ state: "skipped", reason: "budget" });

      const hostile = JSON.parse(
        await inContainer(
          container,
          String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const original = fs.readFileSync("/tmp/cache.sqsh");
const squashfsBytes = Number(original.readBigUInt64LE(40));
const evidence = [];
const write = (name, bytes) => {
  const path = "/tmp/hostile-" + name + ".sqsh";
  fs.writeFileSync(path, bytes);
  evidence.push({ name, path, bytes: bytes.length, digest: crypto.createHash("sha256").update(bytes).digest("hex") });
};
const mutate = (name, change) => {
  const bytes = Buffer.from(original);
  change(bytes);
  write(name, bytes);
};
mutate("compression", (bytes) => bytes.writeUInt16LE(1, 20));
mutate("physical-bytes", (bytes) => bytes.writeBigUInt64LE(BigInt(bytes.length + 1), 40));
mutate("table-bounds", (bytes) => bytes.writeBigUInt64LE(BigInt(squashfsBytes + 1), 48));
mutate("root-inode", (bytes) => bytes.writeBigUInt64LE(8192n, 32));
write("missing-trailer", original.subarray(0, squashfsBytes));
write("trailing-byte", Buffer.concat([original, Buffer.from([0])]));
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
for (const [name, groups] of [
  ["empty-hardlinks", []],
  ["missing-hardlink-member", [["missing-one", "nested/one"]]],
  ["directory-hardlink-member", [["nested", "one-alias"]]],
  ["different-content-hardlink", [["duplicate-content-nonlink", "two"]]],
]) {
  const map = encodeMap(groups);
  const footer = Buffer.alloc(60);
  Buffer.from("52554e574159484c494e4b4d41500000", "hex").copy(footer);
  footer.writeUInt32BE(2, 16);
  footer.writeBigUInt64BE(BigInt(map.length), 20);
  crypto.createHash("sha256").update(map).digest().copy(footer, 28);
  write(name, Buffer.concat([original.subarray(0, squashfsBytes), map, footer]));
}
process.stdout.write(JSON.stringify(evidence));
`,
        ),
      ) as Array<{ name: string; path: string; bytes: number; digest: string }>;
      for (const candidate of hostile) {
        transferSource = candidate.path;
        await expect(
          snapshots.stage({
            object: object(candidate),
            path: `/tmp/rejected-${candidate.name}`,
            budget,
          }),
          candidate.name,
        ).resolves.toMatchObject({ state: "miss" });
      }
    } finally {
      await execute("docker", ["rm", "--force", container]).catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  },
  300_000,
);
