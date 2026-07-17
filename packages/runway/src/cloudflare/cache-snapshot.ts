import type { Budget } from "../run.ts";
import { CACHE_LIMITS } from "../sandbox-config.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ENTRIES = 1_000_000;
const MAX_DEPTH = 256;
const HELPER_MEMORY_BYTES = 1024 * 1024 * 1024;
const HELPER_CPU_SECONDS = 120;
const HELPER_FILE_DESCRIPTORS = 64;
const HELPER_TIMEOUT_SECONDS = CACHE_LIMITS.helperDurationMs / 1000;

export const CACHE_SNAPSHOT_HELPER = String.raw`#!/usr/local/bin/node
const child = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");

const MAX_ENTRIES = 1_000_000;
const MAX_INODES = 1_000_000;
const MAX_DEPTH = 256;
const MAX_COMPONENT = 255;
const MAX_PATH = 4096;
const MAX_LINK = 4096;
const MAX_METADATA = 67_108_864;
const MAX_PHYSICAL = 1_099_511_627_776;
const UINT64 = 0xffff_ffff_ffff_ffffn;
const slash = Buffer.from("/");
const dot = Buffer.from(".");
const dotdot = Buffer.from("..");

const fail = (message) => { throw new Error(message); };
const same = (left, right) => Buffer.compare(left, right) === 0;
const join = (left, right) => Buffer.concat([left, slash, right]);
const parts = (value) => {
  const result = [];
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index === value.length || value[index] === 47) {
      result.push(value.subarray(start, index));
      start = index + 1;
    }
  }
  return result;
};
const field = (hasher, value) => {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.length));
  hasher.update(length);
  hasher.update(value);
};
const safeLink = (path, target) => {
  if (target[0] === 47 || target.includes(0) || target.length > MAX_LINK) fail("unsafe link");
  const resolved = parts(path).slice(0, -1);
  for (const part of parts(target)) {
    if (part.length === 0 || same(part, dot)) continue;
    if (same(part, dotdot)) {
      if (resolved.length === 0) fail("escaping link");
      resolved.pop();
    } else {
      if (part.length > MAX_COMPONENT) fail("link component");
      resolved.push(part);
    }
  }
};
const procPath = (descriptor) => Buffer.from("/proc/self/fd/" + descriptor);
const rootPath = (descriptor, root) => fs.existsSync(procPath(descriptor)) ? procPath(descriptor) : root;
const duplicateDirectory = (descriptor, fallback) => {
  const proc = procPath(descriptor);
  return fs.existsSync(proc)
    ? fs.openSync(proc, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    : fs.openSync(fallback, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
};
const openRelative = (rootDescriptor, root, path, flags) => {
  let current = duplicateDirectory(rootDescriptor, root);
  let currentPath = root;
  try {
    const components = parts(path);
    for (const component of components.slice(0, -1)) {
      const nextPath = join(currentPath, component);
      const next = fs.openSync(join(rootPath(current, currentPath), component), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(current);
      current = next;
      currentPath = nextPath;
    }
    const result = fs.openSync(join(rootPath(current, currentPath), components.at(-1)), flags);
    fs.closeSync(current);
    return result;
  } catch (error) {
    fs.closeSync(current);
    throw error;
  }
};
const pathAt = (descriptor, root, path) => join(rootPath(descriptor, root), path);
const scanTree = (rootValue, maxBytes, includeRecords = false) => {
  const root = Buffer.from(rootValue);
  const rootDescriptor = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const pending = [[Buffer.alloc(0), 0]];
  const found = [];
  let metadata = 0;
  try {
    while (pending.length > 0) {
      const [prefix, depth] = pending.pop();
      const directory = prefix.length === 0
        ? duplicateDirectory(rootDescriptor, root)
        : openRelative(rootDescriptor, root, prefix, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        const directoryPath = prefix.length === 0 ? root : join(root, prefix);
        const entries = fs.readdirSync(rootPath(directory, directoryPath), { encoding: "buffer", withFileTypes: true })
          .sort((left, right) => Buffer.compare(left.name, right.name));
        for (const entry of entries) {
          const name = entry.name;
          if (!Buffer.isBuffer(name) || name.length === 0 || same(name, dot) || same(name, dotdot) || name.length > MAX_COMPONENT || name.includes(47) || name.includes(0)) fail("unsafe name");
          const path = prefix.length === 0 ? name : join(prefix, name);
          const childDepth = depth + 1;
          if (childDepth > MAX_DEPTH || path.length > MAX_PATH) fail("tree depth");
          const absolute = pathAt(rootDescriptor, root, path);
          const info = fs.lstatSync(absolute, { bigint: true });
          let kind;
          let target = null;
          if (info.isDirectory()) kind = Buffer.from("d");
          else if (info.isFile()) kind = Buffer.from("f");
          else if (info.isSymbolicLink()) {
            kind = Buffer.from("l");
            target = fs.readlinkSync(absolute, { encoding: "buffer" });
            safeLink(path, target);
          } else fail("special file");
          metadata += path.length + (target?.length ?? 0) + 96;
          if (metadata > MAX_METADATA) fail("metadata quota");
          found.push({ path, kind, device: info.dev, inode: info.ino, size: info.size, blocks: info.blocks, target, mode: info.mode });
          if (found.length > MAX_ENTRIES) fail("entry quota");
          if (same(kind, Buffer.from("d"))) pending.push([path, childDepth]);
        }
      } finally { fs.closeSync(directory); }
    }
    found.sort((left, right) => Buffer.compare(left.path, right.path));
    const identities = new Map();
    const uniqueFiles = new Set();
    const hasher = crypto.createHash("sha256");
    let byteCount = 0;
    let diskBytes = 0;
    let files = 0;
    let maxDepth = 0;
    for (const record of found) {
      const identity = record.device + ":" + record.inode;
      if (!identities.has(identity)) {
        if (identities.size >= MAX_INODES) fail("inode quota");
        identities.set(identity, identities.size);
        diskBytes += Number(record.blocks * 512n);
      }
      const canonicalInode = identities.get(identity);
      maxDepth = Math.max(maxDepth, parts(record.path).length);
      field(hasher, record.kind);
      field(hasher, record.path);
      field(hasher, Buffer.from(String(canonicalInode)));
      field(hasher, Buffer.from(same(record.kind, Buffer.from("f")) && (record.mode & 73n) !== 0n ? "1" : "0"));
      if (same(record.kind, Buffer.from("f"))) {
        files += 1;
        const size = Number(record.size);
        field(hasher, Buffer.from(String(size)));
        if (!uniqueFiles.has(identity)) {
          if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes - byteCount) fail("expanded byte quota");
          uniqueFiles.add(identity);
          byteCount += size;
          const descriptor = openRelative(rootDescriptor, root, record.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          const content = crypto.createHash("sha256");
          const buffer = Buffer.allocUnsafe(1_048_576);
          let actual = 0;
          try {
            for (;;) {
              const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
              if (bytes === 0) break;
              actual += bytes;
              if (actual > size || actual > maxBytes) fail("file changed");
              content.update(buffer.subarray(0, bytes));
            }
          } finally { fs.closeSync(descriptor); }
          if (actual !== size) fail("file changed");
          field(hasher, content.digest());
        } else field(hasher, Buffer.from("hardlink"));
      } else if (same(record.kind, Buffer.from("l"))) field(hasher, record.target);
    }
    if (diskBytes > maxBytes) fail("disk quota");
    const summary = { byteCount, diskBytes, entryCount: found.length, fileCount: files, maxDepth, schema: 1, treeDigest: hasher.digest("hex"), uniqueInodes: identities.size };
    if (includeRecords) return { summary, records: found, rootDescriptor, root };
    fs.closeSync(rootDescriptor);
    return summary;
  } catch (error) {
    fs.closeSync(rootDescriptor);
    throw error;
  }
};
const evidence = (path) => {
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1_048_576);
  let size = 0;
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      size += bytes;
      if (size > MAX_PHYSICAL) fail("physical quota");
      digest.update(buffer.subarray(0, bytes));
    }
  } finally { fs.closeSync(descriptor); }
  return { bytes: size, digest: digest.digest("hex") };
};
const preflight = (path, maxBytes) => {
  const proof = evidence(path);
  if (proof.bytes < 96 || proof.bytes > maxBytes) fail("archive size");
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const block = Buffer.alloc(96);
  try { if (fs.readSync(descriptor, block, 0, 96, 0) !== 96) fail("archive format"); }
  finally { fs.closeSync(descriptor); }
  const magic = block.readUInt32LE(0);
  const inodes = block.readUInt32LE(4);
  const blockSize = block.readUInt32LE(12);
  const fragments = block.readUInt32LE(16);
  const compression = block.readUInt16LE(20);
  const blockLog = block.readUInt16LE(22);
  const noIds = block.readUInt16LE(26);
  const major = block.readUInt16LE(28);
  const minor = block.readUInt16LE(30);
  const rootInode = block.readBigUInt64LE(32);
  const bytesUsed = block.readBigUInt64LE(40);
  const idStart = block.readBigUInt64LE(48);
  const xattrStart = block.readBigUInt64LE(56);
  const inodeStart = block.readBigUInt64LE(64);
  const directoryStart = block.readBigUInt64LE(72);
  const fragmentStart = block.readBigUInt64LE(80);
  const lookupStart = block.readBigUInt64LE(88);
  if (magic !== 0x73717368 || major !== 4 || minor !== 0 || compression !== 6) fail("archive format");
  if (blockSize < 4096 || blockSize > 1_048_576 || (blockSize & (blockSize - 1)) !== 0 || blockLog !== Math.log2(blockSize)) fail("block geometry");
  if (inodes < 1 || inodes > MAX_INODES || noIds < 1 || noIds > 65_535 || fragments > MAX_INODES) fail("archive counts");
  if (bytesUsed < 96n || bytesUsed > BigInt(proof.bytes)) fail("bytes used");
  if ([idStart, inodeStart, directoryStart].some((value) => value < 96n || value >= bytesUsed)) fail("table bounds");
  if ([xattrStart, fragmentStart, lookupStart].some((value) => value !== UINT64 && (value < 96n || value >= bytesUsed))) fail("table bounds");
  if (fragments && fragmentStart === UINT64) fail("fragment table");
  const rootBlock = rootInode >> 16n;
  const rootOffset = rootInode & 65_535n;
  if (rootOffset >= 8192n || inodeStart + rootBlock < inodeStart || inodeStart + rootBlock >= directoryStart) fail("root inode");
  return proof;
};
const run = (command, capture = false) => {
  const result = child.spawnSync(command[0], command.slice(1), { encoding: capture ? "utf8" : undefined, stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore", timeout: 180_000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error("helper command failed");
  return result;
};
const sameTree = (left, right) => ["schema", "treeDigest", "entryCount", "uniqueInodes", "fileCount", "byteCount", "maxDepth"].every((field) => left[field] === right[field]);
const mountScan = (helper, archive, mount, maxBytes, mode, staging, expected) => {
  const command = ["unshare", "--mount", "--propagation", "private", "--fork", "/usr/local/bin/node", helper, mode, archive, mount, String(maxBytes)];
  if (staging !== undefined) command.push(staging, JSON.stringify(expected));
  return JSON.parse(run(command, true).stdout);
};
const isMounted = (mount) => fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").some((line) => line.split(" ")[4] === mount);
const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
const copyTree = (sourceDescriptor, sourceRoot, records, staging, maxBytes) => {
  fs.mkdirSync(staging, { mode: 0o700 });
  const destinationRoot = Buffer.from(staging);
  const destinationDescriptor = fs.openSync(destinationRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const first = new Map();
  let actual = 0;
  try {
    for (const record of records) if (same(record.kind, Buffer.from("d"))) fs.mkdirSync(pathAt(destinationDescriptor, destinationRoot, record.path), { mode: 0o755 });
    for (const record of records) {
      if (!same(record.kind, Buffer.from("f"))) continue;
      const identity = record.device + ":" + record.inode;
      const destination = pathAt(destinationDescriptor, destinationRoot, record.path);
      if (first.has(identity)) fs.linkSync(pathAt(destinationDescriptor, destinationRoot, first.get(identity)), destination);
      else {
        const source = openRelative(sourceDescriptor, sourceRoot, record.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const target = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, (record.mode & 73n) !== 0n ? 0o755 : 0o644);
        const buffer = Buffer.allocUnsafe(1_048_576);
        try {
          for (;;) {
            const bytes = fs.readSync(source, buffer, 0, buffer.length, null);
            if (bytes === 0) break;
            actual += bytes;
            if (actual > maxBytes) fail("copy byte quota");
            let offset = 0;
            while (offset < bytes) offset += fs.writeSync(target, buffer, offset, bytes - offset);
          }
        } finally { fs.closeSync(source); fs.closeSync(target); }
        first.set(identity, record.path);
      }
    }
    for (const record of records) if (same(record.kind, Buffer.from("l"))) fs.symlinkSync(record.target, pathAt(destinationDescriptor, destinationRoot, record.path));
  } catch (error) {
    fs.closeSync(destinationDescriptor);
    fs.rmSync(staging, { force: true, recursive: true });
    throw error;
  }
  fs.closeSync(destinationDescriptor);
};
const mounted = (helper, archive, mount, maxBytes, staging, expected) => {
  preflight(archive, maxBytes);
  fs.mkdirSync(mount, { mode: 0o700 });
  const process = child.spawn("squashfuse", ["-f", "-o", "ro,nodev,nosuid,noexec", archive, mount], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 10_000;
    while (!isMounted(mount)) {
      if (process.exitCode !== null || Date.now() > deadline) fail("mount unavailable");
      sleep(20);
    }
    if (staging === undefined) return scanTree(mount, maxBytes);
    const scanned = scanTree(mount, maxBytes, true);
    if (!sameTree(scanned.summary, expected)) fail("tree evidence");
    try { copyTree(scanned.rootDescriptor, scanned.root, scanned.records, staging, maxBytes); }
    finally { fs.closeSync(scanned.rootDescriptor); }
    const restored = scanTree(staging, maxBytes);
    if (!sameTree(restored, expected)) fail("restored evidence");
    return restored;
  } finally {
    for (const tool of ["fusermount3", "fusermount"]) {
      if (!isMounted(mount)) break;
      child.spawnSync(tool, ["-u", mount], { stdio: "ignore", timeout: 10_000 });
    }
    if (process.exitCode === null) process.kill("SIGKILL");
    if (isMounted(mount)) fail("mount cleanup");
    fs.rmSync(mount, { force: true, recursive: true });
  }
};
const main = () => {
  const mode = process.argv[2];
  let result;
  if (mode === "scan") result = scanTree(process.argv[3], Number(process.argv[4]));
  else if (mode === "inspect") {
    const path = process.argv[3];
    if (!fs.existsSync(path)) result = { state: "absent" };
    else {
      const info = fs.lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe target");
      result = { state: fs.readdirSync(path).length === 0 ? "empty" : "nonempty" };
    }
  } else if (mode === "preflight") result = preflight(process.argv[3], Number(process.argv[4]));
  else if (mode === "copy") {
    const [source, staging, maxBytes] = [process.argv[3], process.argv[4], Number(process.argv[5])];
    const scanned = scanTree(source, maxBytes, true);
    try { copyTree(scanned.rootDescriptor, scanned.root, scanned.records, staging, maxBytes); }
    finally { fs.closeSync(scanned.rootDescriptor); }
    result = scanTree(staging, maxBytes);
    if (!sameTree(result, scanned.summary)) fail("copied evidence");
  } else if (mode === "capture") {
    const [target, archive, mount, maxBytes] = [process.argv[3], process.argv[4], process.argv[5], Number(process.argv[6])];
    const before = scanTree(target, maxBytes);
    try { fs.unlinkSync(archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
    run(["mksquashfs", target, archive, "-comp", "zstd", "-noappend", "-no-progress", "-all-root", "-no-xattrs", "-no-exports", "-mkfs-time", "0", "-all-time", "0"]);
    const proof = preflight(archive, maxBytes);
    const after = scanTree(target, maxBytes);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail("source changed");
    const mountedSummary = mountScan(process.argv[1], archive, mount, maxBytes, "mounted-scan");
    if (!sameTree(before, mountedSummary)) fail("archive tree changed");
    before.diskBytes = Math.max(before.diskBytes, mountedSummary.diskBytes);
    result = { ...before, archive: proof };
  } else if (mode === "mounted-scan") result = mounted(process.argv[1], process.argv[3], process.argv[4], Number(process.argv[5]));
  else if (mode === "restore") {
    const [archive, mount, staging, maxBytes] = [process.argv[3], process.argv[4], process.argv[5], Number(process.argv[6])];
    const expected = JSON.parse(process.argv[7]);
    const proof = preflight(archive, maxBytes);
    if (proof.bytes !== Number(process.argv[8]) || proof.digest !== process.argv[9]) fail("archive evidence");
    result = mountScan(process.argv[1], archive, mount, maxBytes, "mounted-restore", staging, expected);
  } else if (mode === "mounted-restore") result = mounted(process.argv[1], process.argv[3], process.argv[4], Number(process.argv[5]), process.argv[6], JSON.parse(process.argv[7]));
  else fail("invalid mode");
  process.stdout.write(JSON.stringify(result));
};
const reason = (error) => {
  const message = String(error?.message ?? error);
  if (["unsafe", "escaping", "special file", "component", "tree depth"].some((word) => message.includes(word))) return "unsafe";
  if (["quota", "archive size"].some((word) => message.includes(word))) return "budget";
  if (["archive format", "block geometry", "archive counts", "bytes used", "table bounds", "fragment table", "root inode", "archive evidence", "tree evidence", "restored evidence"].some((word) => message.includes(word))) return "corrupt";
  return "unavailable";
};
try { main(); }
catch (error) {
  const mode = process.argv[2] ?? "";
  if (mode === "capture") process.stdout.write(JSON.stringify({ reason: reason(error), state: "skipped" }));
  else if (mode === "restore") process.stdout.write(JSON.stringify({ reason: reason(error), state: "miss" }));
  else process.exitCode = 1;
}
`;

interface ArchiveEvidence {
  readonly bytes: number;
  readonly digest: string;
}

interface TreeSummary {
  readonly schema: 1;
  readonly treeDigest: string;
  readonly entryCount: number;
  readonly uniqueInodes: number;
  readonly fileCount: number;
  readonly byteCount: number;
  readonly diskBytes: number;
  readonly maxDepth: number;
}

export interface CacheSnapshotProcess {
  write(path: string, contents: string): Promise<void>;
  execute(command: string, timeoutMs: number): Promise<{ readonly stdout: string }>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  close(): Promise<void>;
}

interface CacheSnapshotTransfer {
  put(request: {
    readonly runId: string;
    readonly key: string;
    readonly path: string;
  }): Promise<ArchiveEvidence & { readonly state: "stored" | "present"; readonly path?: string }>;
  get(request: {
    readonly runId: string;
    readonly key: string;
    readonly path: string;
    readonly expected: ArchiveEvidence;
  }): Promise<ArchiveEvidence>;
}

interface CloudflareCacheSnapshotOptions {
  readonly runId?: string;
  readonly process: () => Promise<CacheSnapshotProcess>;
  readonly transfer: CacheSnapshotTransfer;
  readonly now?: () => number;
}

type SnapshotBudget = Partial<Budget> | undefined;

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;

const parseSummary = (value: unknown): TreeSummary => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const summary = value as Record<string, unknown>;
  if (
    Object.keys(summary).sort().join(",") !==
      "byteCount,diskBytes,entryCount,fileCount,maxDepth,schema,treeDigest,uniqueInodes" ||
    summary.schema !== 1 ||
    typeof summary.treeDigest !== "string" ||
    !SHA256.test(summary.treeDigest) ||
    !integer(summary.entryCount, MAX_ENTRIES) ||
    !integer(summary.uniqueInodes, MAX_ENTRIES) ||
    !integer(summary.fileCount, MAX_ENTRIES) ||
    !integer(summary.byteCount) ||
    !integer(summary.diskBytes) ||
    !integer(summary.maxDepth, MAX_DEPTH) ||
    summary.fileCount > summary.entryCount ||
    summary.uniqueInodes > summary.entryCount ||
    (summary.entryCount === 0 &&
      (summary.uniqueInodes !== 0 ||
        summary.fileCount !== 0 ||
        summary.byteCount !== 0 ||
        summary.maxDepth !== 0)) ||
    (summary.entryCount > 0 && (summary.uniqueInodes === 0 || summary.maxDepth === 0)) ||
    (summary.fileCount === 0 && summary.byteCount !== 0) ||
    (summary.byteCount > 0 && summary.fileCount === 0)
  ) {
    throw new Error();
  }
  return summary as unknown as TreeSummary;
};

const parseArchive = (value: unknown): ArchiveEvidence => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const archive = value as Record<string, unknown>;
  if (
    Object.keys(archive).sort().join(",") !== "bytes,digest" ||
    !integer(archive.bytes) ||
    typeof archive.digest !== "string" ||
    !SHA256.test(archive.digest)
  ) {
    throw new Error();
  }
  return archive as unknown as ArchiveEvidence;
};

const maximumBytes = (budget: SnapshotBudget): number => budget?.maxBytes ?? CACHE_LIMITS.maxBytes;

const sameTree = (left: TreeSummary, right: TreeSummary): boolean =>
  (
    [
      "schema",
      "treeDigest",
      "entryCount",
      "uniqueInodes",
      "fileCount",
      "byteCount",
      "maxDepth",
    ] as const
  ).every((field) => left[field] === right[field]);

const command = (
  helper: string,
  mode: string,
  fields: readonly (string | number)[],
  durationMs = HELPER_TIMEOUT_SECONDS * 1000,
): string => {
  const timeoutSeconds = Math.min(HELPER_TIMEOUT_SECONDS, Math.max(0.001, durationMs / 1000));
  const cpuSeconds = Math.min(HELPER_CPU_SECONDS, Math.max(1, Math.ceil(timeoutSeconds)));
  return `timeout --signal=KILL ${timeoutSeconds}s prlimit --as=${HELPER_MEMORY_BYTES} --cpu=${cpuSeconds} --nofile=${HELPER_FILE_DESCRIPTORS} -- /usr/local/bin/node ${shellQuote(helper)} ${mode} ${fields.map((field) => shellQuote(String(field))).join(" ")}`;
};

const duration = (budget: SnapshotBudget): number =>
  Math.min(
    HELPER_TIMEOUT_SECONDS * 1000,
    Math.max(1, budget?.maxDurationMs ?? HELPER_TIMEOUT_SECONDS * 1000),
  );

export class CloudflareCacheSnapshot {
  readonly #now: () => number;
  readonly #process: () => Promise<CacheSnapshotProcess>;
  readonly #runId: string;
  readonly #transfer: CacheSnapshotTransfer;

  constructor(options: CloudflareCacheSnapshotOptions) {
    this.#runId = options.runId ?? "cache";
    this.#process = options.process;
    this.#transfer = options.transfer;
    this.#now = options.now ?? Date.now;
  }

  async #withProcess<T>(
    work: (process: CacheSnapshotProcess, helper: string) => Promise<T>,
  ): Promise<T> {
    const process = await this.#process();
    const helper = `/tmp/.runway-cache-helper-${crypto.randomUUID()}.cjs`;
    let outcome:
      | { readonly state: "done"; readonly value: T }
      | { readonly state: "failed"; readonly error: unknown };
    try {
      await process.write(helper, CACHE_SNAPSHOT_HELPER);
      outcome = await work(process, helper).then(
        (value) => ({ state: "done" as const, value }),
        (error: unknown) => ({ state: "failed" as const, error }),
      );
    } finally {
      await process.remove(helper).catch(() => undefined);
    }
    await process.close();
    if (outcome!.state === "failed") throw outcome!.error;
    return outcome!.value;
  }

  async inspect(path: string): Promise<"absent" | "empty" | "nonempty"> {
    return await this.#withProcess(async (process, helper) => {
      const result = await process.execute(
        command(helper, "inspect", [path]),
        HELPER_TIMEOUT_SECONDS * 1000,
      );
      const value = JSON.parse(result.stdout) as Record<string, unknown>;
      if (
        Object.keys(value).join(",") !== "state" ||
        !["absent", "empty", "nonempty"].includes(String(value.state))
      )
        throw new Error();
      return value.state as "absent" | "empty" | "nonempty";
    });
  }

  async capture(request: {
    readonly target: string;
    readonly path: string;
    readonly budget: SnapshotBudget;
  }) {
    if (request.budget?.maxBytes === 0 || request.budget?.maxDurationMs === 0) {
      return { state: "skipped" as const, reason: "budget" as const };
    }
    const started = this.#now();
    try {
      return await this.#withProcess(async (process, helper) => {
        const mount = `/tmp/.runway-cache-mount-${crypto.randomUUID()}`;
        const result = await process.execute(
          command(
            helper,
            "capture",
            [request.target, request.path, mount, maximumBytes(request.budget)],
            request.budget?.maxDurationMs,
          ),
          duration(request.budget),
        );
        const value = JSON.parse(result.stdout) as Record<string, unknown>;
        if (
          Object.keys(value).sort().join(",") === "reason,state" &&
          value.state === "skipped" &&
          ["unsafe", "corrupt", "unavailable", "budget"].includes(String(value.reason))
        ) {
          return {
            state: "skipped" as const,
            reason: value.reason as "unsafe" | "corrupt" | "unavailable" | "budget",
          };
        }
        if (
          Object.keys(value).sort().join(",") !==
          "archive,byteCount,diskBytes,entryCount,fileCount,maxDepth,schema,treeDigest,uniqueInodes"
        )
          throw new Error();
        const { archive, ...summaryValue } = value;
        const summary = parseSummary(summaryValue);
        const evidence = parseArchive(archive);
        return {
          state: "ready" as const,
          archive: { path: request.path, ...evidence },
          treeDigest: summary.treeDigest,
          entryCount: summary.entryCount,
          uniqueInodes: summary.uniqueInodes,
          fileCount: summary.fileCount,
          byteCount: summary.byteCount,
          diskBytes: summary.diskBytes,
          maxDepth: summary.maxDepth,
          durationMs: Math.max(0, this.#now() - started),
        };
      });
    } catch {
      return { state: "skipped" as const, reason: "corrupt" as const };
    }
  }

  async upload(request: {
    readonly key: string;
    readonly path: string;
    readonly expected: ArchiveEvidence;
  }) {
    const uploaded = await this.#transfer.put({
      runId: this.#runId,
      key: request.key,
      path: request.path,
    });
    if (uploaded.bytes !== request.expected.bytes || uploaded.digest !== request.expected.digest)
      throw new Error();
    return {
      state: uploaded.state,
      path: request.path,
      bytes: uploaded.bytes,
      digest: uploaded.digest,
    };
  }

  async stage(request: {
    readonly object: {
      readonly digest: string;
      readonly archiveBytes: number;
      readonly archiveDigest: string;
      readonly byteCount: number;
      readonly fileCount: number;
      readonly treeDigest: string;
      readonly entryCount: number;
      readonly uniqueInodes: number;
      readonly maxDepth: number;
    };
    readonly path: string;
    readonly budget: SnapshotBudget;
  }) {
    if (request.budget?.maxBytes === 0 || request.budget?.maxDurationMs === 0) {
      return { state: "miss" as const, reason: "budget" as const };
    }
    const archivePath = `${request.path}.sqsh`;
    const expected = { bytes: request.object.archiveBytes, digest: request.object.archiveDigest };
    try {
      const downloaded = await this.#transfer.get({
        runId: this.#runId,
        key: `content/${request.object.digest}.sqsh`,
        path: archivePath,
        expected,
      });
      if (downloaded.bytes !== expected.bytes || downloaded.digest !== expected.digest)
        throw new Error();
      return await this.#withProcess(async (process, helper) => {
        const summary: TreeSummary = {
          schema: 1,
          treeDigest: request.object.treeDigest,
          entryCount: request.object.entryCount,
          uniqueInodes: request.object.uniqueInodes,
          fileCount: request.object.fileCount,
          byteCount: request.object.byteCount,
          diskBytes: 0,
          maxDepth: request.object.maxDepth,
        };
        parseSummary(summary);
        const mount = `/tmp/.runway-cache-mount-${crypto.randomUUID()}`;
        const result = await process.execute(
          command(
            helper,
            "restore",
            [
              archivePath,
              mount,
              request.path,
              maximumBytes(request.budget),
              JSON.stringify(summary),
              expected.bytes,
              expected.digest,
            ],
            request.budget?.maxDurationMs,
          ),
          duration(request.budget),
        );
        const value = JSON.parse(result.stdout) as Record<string, unknown>;
        if (
          Object.keys(value).sort().join(",") === "reason,state" &&
          value.state === "miss" &&
          ["corrupt", "unavailable", "budget"].includes(String(value.reason))
        ) {
          return {
            state: "miss" as const,
            reason: value.reason as "corrupt" | "unavailable" | "budget",
          };
        }
        const restored = parseSummary(value);
        if (!sameTree(restored, summary)) throw new Error();
        return {
          state: "ready" as const,
          archiveBytes: expected.bytes,
          archiveDigest: expected.digest,
          treeDigest: restored.treeDigest,
          entryCount: restored.entryCount,
          uniqueInodes: restored.uniqueInodes,
          fileCount: restored.fileCount,
          byteCount: restored.byteCount,
          diskBytes: restored.diskBytes,
          maxDepth: restored.maxDepth,
        };
      });
    } catch {
      return { state: "miss" as const, reason: "corrupt" as const };
    } finally {
      await this.remove(archivePath).catch(() => undefined);
    }
  }

  async remove(path: string): Promise<void> {
    const process = await this.#process();
    try {
      await process.remove(path);
    } finally {
      await process.close();
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const process = await this.#process();
    try {
      await process.rename(from, to);
    } finally {
      await process.close();
    }
  }
}
