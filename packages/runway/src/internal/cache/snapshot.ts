import { CACHE_LIMITS } from "../sandbox/config.ts";
import type { Budget } from "./cache.ts";
import { normalizedCacheTarget } from "./path.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ENTRIES = 1_000_000;
const MAX_DEPTH = 256;
const HELPER_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const HELPER_CPU_SECONDS = 120;
const HELPER_FILE_DESCRIPTORS = 64;
const SNAPSHOT_PROCESSORS = 2;
const HELPER_TIMEOUT_SECONDS = CACHE_LIMITS.helperDurationMs / 1000;

const CACHE_SNAPSHOT_HELPER = String.raw`#!/usr/local/bin/node
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
const TRAILER_MAGIC = Buffer.from("52554e574159484c494e4b4d41500000", "hex");
const TRAILER_SCHEMA = 2;
const TRAILER_FOOTER_BYTES = 60;
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
const validPath = (path) => {
  if (path.length === 0 || path.length > MAX_PATH || path.includes(0)) fail("hardlink path");
  const components = parts(path);
  if (components.length > MAX_DEPTH || components.some((part) => part.length === 0 || part.length > MAX_COMPONENT || same(part, dot) || same(part, dotdot))) fail("hardlink path");
};
const encodeHardlinks = (groups) => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(groups.length);
  const fields = [header];
  for (const group of groups) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(group.length);
    fields.push(count);
    for (const path of group) {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(path.length);
      fields.push(length, path);
    }
  }
  const encoded = Buffer.concat(fields);
  if (encoded.length > MAX_METADATA) fail("hardlink map quota");
  return encoded;
};
const hardlinkGroups = (records) => {
  const aliases = new Map();
  for (const record of records) {
    if (!same(record.kind, Buffer.from("f"))) continue;
    const identity = record.device + ":" + record.inode;
    const group = aliases.get(identity) ?? [];
    group.push(record.path);
    aliases.set(identity, group);
  }
  return [...aliases.values()]
    .filter((group) => group.length >= 2)
    .map((group) => group.sort(Buffer.compare))
    .sort((left, right) => Buffer.compare(left[0], right[0]));
};
const parseHardlinks = (encoded) => {
  if (encoded.length < 4 || encoded.length > MAX_METADATA) fail("hardlink map quota");
  let offset = 0;
  const take32 = () => {
    if (offset > encoded.length - 4) fail("hardlink map");
    const value = encoded.readUInt32BE(offset);
    offset += 4;
    return value;
  };
  const groupCount = take32();
  if (groupCount > Math.floor(MAX_ENTRIES / 2)) fail("hardlink map quota");
  const groups = [];
  const seen = [];
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const count = take32();
    if (count < 2 || count > MAX_ENTRIES) fail("hardlink map");
    const group = [];
    for (let pathIndex = 0; pathIndex < count; pathIndex += 1) {
      const length = take32();
      if (length === 0 || length > MAX_PATH || offset > encoded.length - length) fail("hardlink path");
      const path = Buffer.from(encoded.subarray(offset, offset + length));
      offset += length;
      validPath(path);
      if (group.length > 0 && Buffer.compare(group.at(-1), path) >= 0) fail("noncanonical hardlink map");
      group.push(path);
      seen.push(path);
      if (seen.length > MAX_ENTRIES) fail("hardlink map quota");
    }
    if (groups.length > 0 && Buffer.compare(groups.at(-1)[0], group[0]) >= 0) fail("noncanonical hardlink map");
    groups.push(group);
  }
  if (offset !== encoded.length || !same(encodeHardlinks(groups), encoded)) fail("noncanonical hardlink map");
  seen.sort(Buffer.compare);
  for (let index = 1; index < seen.length; index += 1) {
    const previous = seen[index - 1];
    const current = seen[index];
    if (same(previous, current) || (current.length > previous.length && current[previous.length] === 47 && same(current.subarray(0, previous.length), previous))) fail("hardlink path overlap");
  }
  return groups;
};
const safeLink = (root, path, target) => {
  if (target.includes(0) || target.length > MAX_LINK) fail("unsafe link");
  const absolute = target[0] === 47;
  const relative = absolute
    ? same(target, root)
      ? Buffer.alloc(0)
      : target.length > root.length && target[root.length] === 47 && same(target.subarray(0, root.length), root)
        ? target.subarray(root.length + 1)
        : fail("unsafe link")
    : target;
  const resolved = absolute ? [] : parts(path).slice(0, -1);
  for (const part of parts(relative)) {
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
const parentRelative = (rootDescriptor, root, path) => {
  const components = parts(path);
  const name = components.at(-1);
  if (components.length === 1) {
    return { descriptor: duplicateDirectory(rootDescriptor, root), name, path: root };
  }
  const parent = Buffer.concat(
    components.slice(0, -1).flatMap((component, index) =>
      index === 0 ? [component] : [slash, component],
    ),
  );
  return {
    descriptor: openRelative(
      rootDescriptor,
      root,
      parent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    ),
    name,
    path: join(root, parent),
  };
};
const scanTree = (rootValue, maxBytes, includeRecords = false, hardlinks = null, linkRootValue = rootValue) => {
  const root = Buffer.from(rootValue);
  const linkRoot = Buffer.from(linkRootValue);
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
          const absolute = join(rootPath(directory, directoryPath), name);
          const info = fs.lstatSync(absolute, { bigint: true });
          let kind;
          let target = null;
          if (info.isDirectory()) kind = Buffer.from("d");
          else if (info.isFile()) kind = Buffer.from("f");
          else if (info.isSymbolicLink()) {
            kind = Buffer.from("l");
            target = fs.readlinkSync(absolute, { encoding: "buffer" });
            safeLink(linkRoot, path, target);
          } else fail("special file");
          metadata += path.length + (target?.length ?? 0) + 96;
          if (metadata > MAX_METADATA) fail("metadata quota");
          found.push({ path, kind, device: info.dev, inode: info.ino, nlink: info.nlink, size: info.size, blocks: info.blocks, target, mode: info.mode });
          if (found.length > MAX_ENTRIES) fail("entry quota");
          if (same(kind, Buffer.from("d"))) pending.push([path, childDepth]);
        }
      } finally { fs.closeSync(directory); }
    }
    found.sort((left, right) => Buffer.compare(left.path, right.path));
    const mapped = new Map();
    if (hardlinks !== null) {
      const foundPaths = new Set(found.map((record) => record.path.toString("hex")));
      for (const [groupIndex, group] of hardlinks.entries()) {
        for (const path of group) mapped.set(path.toString("hex"), { groupIndex, count: group.length });
      }
      for (const record of found) {
        const entry = mapped.get(record.path.toString("hex"));
        if (entry) {
          if (!same(record.kind, Buffer.from("f")) || (record.nlink !== 1n && record.nlink !== BigInt(entry.count))) fail("hardlink membership");
        } else if (same(record.kind, Buffer.from("f")) && record.nlink !== 1n) fail("unlisted hardlink");
      }
      if ([...mapped.keys()].some((path) => !foundPaths.has(path))) fail("hardlink membership");
    }
    const identities = new Map();
    const uniqueFiles = new Set();
    const mappedContent = new Map();
    const hasher = crypto.createHash("sha256");
    let byteCount = 0;
    let diskBytes = 0;
    let files = 0;
    let maxDepth = 0;
    for (const record of found) {
      const mapping = mapped.get(record.path.toString("hex"));
      const identity = hardlinks === null
        ? record.device + ":" + record.inode
        : mapping
          ? "hardlink:" + mapping.groupIndex
          : "path:" + record.path.toString("hex");
      record.identity = identity;
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
        const firstFile = !uniqueFiles.has(identity);
        if (firstFile) {
          if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes - byteCount) fail("expanded byte quota");
          uniqueFiles.add(identity);
          byteCount += size;
        }
        if (firstFile || mapping) {
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
          const digest = content.digest();
          if (mapping) {
            const previous = mappedContent.get(mapping.groupIndex);
            if (previous && (previous.size !== size || !same(previous.digest, digest))) fail("hardlink content");
            if (!previous) mappedContent.set(mapping.groupIndex, { size, digest });
          }
          if (firstFile) field(hasher, digest);
          else field(hasher, Buffer.from("hardlink"));
        } else field(hasher, Buffer.from("hardlink"));
      } else if (same(record.kind, Buffer.from("l"))) field(hasher, record.target);
    }
    if (diskBytes > maxBytes) fail("disk quota");
    const summary = { byteCount, diskBytes, entryCount: found.length, fileCount: files, maxDepth, schema: 2, treeDigest: hasher.digest("hex"), uniqueInodes: identities.size };
    if (includeRecords) return { summary, records: found, rootDescriptor, root };
    fs.closeSync(rootDescriptor);
    return summary;
  } catch (error) {
    fs.closeSync(rootDescriptor);
    throw error;
  }
};
const evidence = (path, maximum = MAX_PHYSICAL) => {
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1_048_576);
  let size = 0;
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      size += bytes;
      if (size > maximum || size > MAX_PHYSICAL) fail("physical quota");
      digest.update(buffer.subarray(0, bytes));
    }
  } finally { fs.closeSync(descriptor); }
  return { bytes: size, digest: digest.digest("hex") };
};
const superblock = (path, maximum) => {
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
  if (bytesUsed < 96n || bytesUsed > BigInt(maximum)) fail("bytes used");
  if ([idStart, inodeStart, directoryStart].some((value) => value < 96n || value >= bytesUsed)) fail("table bounds");
  if ([xattrStart, fragmentStart, lookupStart].some((value) => value !== UINT64 && (value < 96n || value >= bytesUsed))) fail("table bounds");
  if (fragments && fragmentStart === UINT64) fail("fragment table");
  const rootBlock = rootInode >> 16n;
  const rootOffset = rootInode & 65_535n;
  if (rootOffset >= 8192n || inodeStart + rootBlock < inodeStart || inodeStart + rootBlock >= directoryStart) fail("root inode");
  return Number(bytesUsed);
};
const appendTrailer = (path, groups, maxBytes) => {
  const physical = evidence(path, maxBytes);
  const squashfsBytes = superblock(path, physical.bytes);
  const map = encodeHardlinks(groups);
  const objectBytes = squashfsBytes + map.length + TRAILER_FOOTER_BYTES;
  if (objectBytes > maxBytes) fail("archive size");
  fs.truncateSync(path, squashfsBytes);
  const footer = Buffer.alloc(TRAILER_FOOTER_BYTES);
  TRAILER_MAGIC.copy(footer, 0);
  footer.writeUInt32BE(TRAILER_SCHEMA, 16);
  footer.writeBigUInt64BE(BigInt(map.length), 20);
  crypto.createHash("sha256").update(map).digest().copy(footer, 28);
  fs.appendFileSync(path, map);
  fs.appendFileSync(path, footer);
};
const preflight = (path, maxBytes, includeHardlinks = false) => {
  const proof = evidence(path, maxBytes);
  if (proof.bytes < 96 + TRAILER_FOOTER_BYTES || proof.bytes > maxBytes) fail("archive size");
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const footer = Buffer.alloc(TRAILER_FOOTER_BYTES);
  try {
    if (fs.readSync(descriptor, footer, 0, footer.length, proof.bytes - footer.length) !== footer.length) fail("hardlink trailer");
  } finally { fs.closeSync(descriptor); }
  if (!same(footer.subarray(0, 16), TRAILER_MAGIC) || footer.readUInt32BE(16) !== TRAILER_SCHEMA) fail("hardlink trailer");
  const mapLengthValue = footer.readBigUInt64BE(20);
  if (mapLengthValue > BigInt(MAX_METADATA) || mapLengthValue > BigInt(proof.bytes - 96 - TRAILER_FOOTER_BYTES)) fail("hardlink map quota");
  const mapLength = Number(mapLengthValue);
  const mapStart = proof.bytes - TRAILER_FOOTER_BYTES - mapLength;
  if (superblock(path, mapStart) !== mapStart) fail("bytes used");
  const map = Buffer.alloc(mapLength);
  const mapDescriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (fs.readSync(mapDescriptor, map, 0, map.length, mapStart) !== map.length) fail("hardlink map");
  } finally { fs.closeSync(mapDescriptor); }
  if (!same(crypto.createHash("sha256").update(map).digest(), footer.subarray(28))) fail("hardlink map digest");
  const groups = parseHardlinks(map);
  return includeHardlinks ? { proof, groups } : proof;
};
const run = (command, capture = false) => {
  const result = child.spawnSync(command[0], command.slice(1), { encoding: capture ? "utf8" : undefined, stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore", timeout: 180_000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error("helper command failed");
  return result;
};
const sameTree = (left, right) => ["schema", "treeDigest", "entryCount", "uniqueInodes", "fileCount", "byteCount", "maxDepth"].every((field) => left[field] === right[field]);
const mountScan = (helper, archive, mount, maxBytes, mode, linkRoot, staging, expected) => {
  const command = ["unshare", "--mount", "--propagation", "private", "--fork", "/usr/local/bin/node", helper, mode, archive, mount, String(maxBytes), linkRoot];
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
    for (const record of records) {
      if (!same(record.kind, Buffer.from("d"))) continue;
      const parent = parentRelative(destinationDescriptor, destinationRoot, record.path);
      try {
        fs.mkdirSync(join(rootPath(parent.descriptor, parent.path), parent.name), { mode: 0o755 });
      } finally {
        fs.closeSync(parent.descriptor);
      }
    }
    for (const record of records) {
      if (!same(record.kind, Buffer.from("f"))) continue;
      const identity = record.identity;
      const destinationParent = parentRelative(destinationDescriptor, destinationRoot, record.path);
      const destination = join(rootPath(destinationParent.descriptor, destinationParent.path), destinationParent.name);
      try {
        if (first.has(identity)) {
          const sourceParent = parentRelative(destinationDescriptor, destinationRoot, first.get(identity));
          try {
            fs.linkSync(join(rootPath(sourceParent.descriptor, sourceParent.path), sourceParent.name), destination);
          } finally {
            fs.closeSync(sourceParent.descriptor);
          }
          continue;
        }
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
      } finally {
        fs.closeSync(destinationParent.descriptor);
      }
    }
    for (const record of records) {
      if (!same(record.kind, Buffer.from("l"))) continue;
      const parent = parentRelative(destinationDescriptor, destinationRoot, record.path);
      try {
        fs.symlinkSync(record.target, join(rootPath(parent.descriptor, parent.path), parent.name));
      } finally {
        fs.closeSync(parent.descriptor);
      }
    }
  } catch (error) {
    fs.closeSync(destinationDescriptor);
    fs.rmSync(staging, { force: true, recursive: true });
    throw error;
  }
  fs.closeSync(destinationDescriptor);
};
const prepareParent = (targetValue) => {
  const target = Buffer.from(targetValue);
  const components = parts(target);
  if (
    target[0] !== 47 ||
    components.length < 3 ||
    components[0].length !== 0 ||
    !(same(components[1], Buffer.from("cache")) || same(components[1], Buffer.from("workspace")))
  ) fail("unsafe target parent");
  let current = Buffer.from("/");
  for (const component of components.slice(1, -1)) {
    if (component.length === 0 || component.length > MAX_COMPONENT || same(component, dot) || same(component, dotdot)) fail("unsafe target parent");
    const next = current.length === 1 ? Buffer.concat([current, component]) : join(current, component);
    try { fs.mkdirSync(next, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = fs.lstatSync(next);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe target parent");
    current = next;
  }
};
const mounted = (helper, archive, mount, maxBytes, linkRoot, staging, expected) => {
  const { groups } = preflight(archive, maxBytes, true);
  fs.mkdirSync(mount, { mode: 0o700 });
  const process = child.spawn("squashfuse", ["-f", "-o", "ro,nodev,nosuid,noexec", archive, mount], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 10_000;
    while (!isMounted(mount)) {
      if (process.exitCode !== null || Date.now() > deadline) fail("mount unavailable");
      sleep(20);
    }
    if (staging === undefined) return scanTree(mount, maxBytes, false, groups, linkRoot);
    const scanned = scanTree(mount, maxBytes, true, groups, linkRoot);
    if (!sameTree(scanned.summary, expected)) fail("tree evidence");
    prepareParent(staging);
    try { copyTree(scanned.rootDescriptor, scanned.root, scanned.records, staging, maxBytes); }
    finally { fs.closeSync(scanned.rootDescriptor); }
    const restored = scanTree(staging, maxBytes, false, null, linkRoot);
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
    const source = scanTree(target, maxBytes, true);
    const before = source.summary;
    const groups = hardlinkGroups(source.records);
    fs.closeSync(source.rootDescriptor);
    try { fs.unlinkSync(archive); } catch (error) { if (error.code !== "ENOENT") throw error; }
    run(["mksquashfs", target, archive, "-comp", "zstd", "-processors", "${SNAPSHOT_PROCESSORS}", "-noappend", "-no-progress", "-all-root", "-no-xattrs", "-no-exports", "-mkfs-time", "0", "-all-time", "0"]);
    appendTrailer(archive, groups, maxBytes);
    const proof = preflight(archive, maxBytes);
    const after = scanTree(target, maxBytes);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail("source changed");
    const mountedSummary = mountScan(process.argv[1], archive, mount, maxBytes, "mounted-scan", target);
    if (!sameTree(before, mountedSummary)) fail("archive tree changed");
    before.diskBytes = Math.max(before.diskBytes, mountedSummary.diskBytes);
    result = { ...before, archive: proof };
  } else if (mode === "mounted-scan") result = mounted(process.argv[1], process.argv[3], process.argv[4], Number(process.argv[5]), process.argv[6]);
  else if (mode === "restore") {
    const [archive, mount, staging, target, maxBytes] = [process.argv[3], process.argv[4], process.argv[5], process.argv[6], Number(process.argv[7])];
    const expected = JSON.parse(process.argv[8]);
    const proof = preflight(archive, maxBytes);
    if (proof.bytes !== Number(process.argv[9]) || proof.digest !== process.argv[10]) fail("archive evidence");
    result = mountScan(process.argv[1], archive, mount, maxBytes, "mounted-restore", target, staging, expected);
  } else if (mode === "mounted-restore") result = mounted(process.argv[1], process.argv[3], process.argv[4], Number(process.argv[5]), process.argv[6], process.argv[7], JSON.parse(process.argv[8]));
  else fail("invalid mode");
  process.stdout.write(JSON.stringify(result));
};
const reason = (error) => {
  const message = String(error?.message ?? error);
  if (["unsafe", "escaping", "special file", "component", "tree depth"].some((word) => message.includes(word))) return "unsafe";
  if (["quota", "archive size"].some((word) => message.includes(word))) return "budget";
  if (["archive format", "block geometry", "archive counts", "bytes used", "table bounds", "fragment table", "root inode", "archive evidence", "tree evidence", "restored evidence", "hardlink"].some((word) => message.includes(word))) return "corrupt";
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
  readonly schema: 2;
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
    summary.schema !== 2 ||
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

  // fallow-ignore-next-line unused-class-member -- called through the cache snapshot contract
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

  // fallow-ignore-next-line unused-class-member -- called through the cache snapshot contract
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
    readonly target: string;
    readonly budget: SnapshotBudget;
  }) {
    if (request.budget?.maxBytes === 0 || request.budget?.maxDurationMs === 0) {
      return { state: "miss" as const, reason: "budget" as const };
    }
    const archivePath = `/tmp/.runway-cache-${crypto.randomUUID()}.sqsh`;
    const expected = { bytes: request.object.archiveBytes, digest: request.object.archiveDigest };
    try {
      const target = normalizedCacheTarget(request.target);
      if (target !== request.target) throw new Error();
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
          schema: 2,
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
              target,
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
