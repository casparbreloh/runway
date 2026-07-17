import type { Budget } from "../run.ts";
import { CACHE_LIMITS } from "../sandbox-config.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ENTRIES = 1_000_000;
const MAX_DEPTH = 256;
const HELPER_MEMORY_BYTES = 1024 * 1024 * 1024;
const HELPER_CPU_SECONDS = 120;
const HELPER_FILE_DESCRIPTORS = 64;
const HELPER_TIMEOUT_SECONDS = CACHE_LIMITS.helperDurationMs / 1000;

export const CACHE_SNAPSHOT_HELPER = String.raw`#!/usr/bin/env python3
import hashlib, json, math, os, resource, shutil, stat, struct, subprocess, sys, time

MAX_ENTRIES=1000000
MAX_INODES=1000000
MAX_DEPTH=256
MAX_COMPONENT=255
MAX_PATH=4096
MAX_LINK=4096
MAX_METADATA=67108864
MAX_PHYSICAL=1099511627776
UINT64=(1<<64)-1

def fail(message):
    raise RuntimeError(message)

def field(hasher, value):
    hasher.update(struct.pack(">Q", len(value)))
    hasher.update(value)

def safe_link(path, target):
    if target.startswith(b"/") or b"\x00" in target or len(target)>MAX_LINK:
        fail("unsafe link")
    parts=path.split(b"/")[:-1]
    for part in target.split(b"/"):
        if part in (b"", b"."):
            continue
        if part==b"..":
            if not parts: fail("escaping link")
            parts.pop()
        else:
            if len(part)>MAX_COMPONENT: fail("link component")
            parts.append(part)

def scan_tree(root, max_bytes, records=False):
    root=os.fsencode(root)
    root_fd=os.open(root, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    pending=[(root,b"",0)]
    found=[]
    metadata=0
    try:
        while pending:
            absolute, prefix, depth=pending.pop()
            directory=os.dup(root_fd) if not prefix else open_relative(root_fd,prefix,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:
                proc_path=b"/proc/self/fd/"+str(directory).encode()
                if os.path.exists(proc_path): scan_path=proc_path
                elif sys.platform=="darwin": scan_path=absolute
                else: fail("fd enumeration unavailable")
                entries=sorted(os.scandir(scan_path), key=lambda entry: entry.name)
                for entry in entries:
                    name=entry.name
                    if not isinstance(name,bytes): fail("non-byte name")
                    if not name or name in (b".",b"..") or len(name)>MAX_COMPONENT or b"/" in name or b"\x00" in name:
                        fail("unsafe name")
                    path=name if not prefix else prefix+b"/"+name
                    child_depth=depth+1
                    if child_depth>MAX_DEPTH or len(path)>MAX_PATH: fail("tree depth")
                    info=os.stat(name, dir_fd=directory, follow_symlinks=False)
                    mode=info.st_mode
                    target=None
                    if stat.S_ISDIR(mode): kind=b"d"
                    elif stat.S_ISREG(mode): kind=b"f"
                    elif stat.S_ISLNK(mode):
                        kind=b"l"
                        target=os.readlink(name, dir_fd=directory)
                        if isinstance(target,str): target=os.fsencode(target)
                        safe_link(path,target)
                    else: fail("special file")
                    metadata+=len(path)+(len(target) if target else 0)+96
                    if metadata>MAX_METADATA: fail("metadata quota")
                    found.append((path,kind,info.st_dev,info.st_ino,info.st_size,info.st_blocks,target,mode))
                    if len(found)>MAX_ENTRIES: fail("entry quota")
                    if kind==b"d":
                        pending.append((absolute+b"/"+name,path,child_depth))
            finally:
                os.close(directory)
    except:
        raise
    found.sort(key=lambda item:item[0])
    identities={}
    unique_files=set()
    hasher=hashlib.sha256()
    byte_count=0
    disk_bytes=0
    files=0
    max_depth=0
    for path,kind,device,inode,size,blocks,target,mode in found:
        identity=(device,inode)
        if identity not in identities:
            if len(identities)>=MAX_INODES: fail("inode quota")
            identities[identity]=len(identities)
            disk_bytes+=blocks*512
        canonical_inode=identities[identity]
        max_depth=max(max_depth,path.count(b"/")+1)
        field(hasher,kind); field(hasher,path); field(hasher,str(canonical_inode).encode())
        field(hasher,b"1" if kind==b"f" and mode&0o111 else b"0")
        if kind==b"f":
            files+=1
            field(hasher,str(size).encode())
            if identity not in unique_files:
                if size<0 or size>max_bytes-byte_count: fail("expanded byte quota")
                unique_files.add(identity); byte_count+=size
                descriptor=open_relative(root_fd,path,os.O_RDONLY|os.O_NOFOLLOW)
                content=hashlib.sha256(); actual=0
                try:
                    while True:
                        chunk=os.read(descriptor,1048576)
                        if not chunk: break
                        actual+=len(chunk)
                        if actual>size or actual>max_bytes: fail("file changed")
                        content.update(chunk)
                finally: os.close(descriptor)
                if actual!=size: fail("file changed")
                field(hasher,content.digest())
            else: field(hasher,b"hardlink")
        elif kind==b"l": field(hasher,target)
    if disk_bytes>max_bytes: fail("disk quota")
    summary={"byteCount":byte_count,"diskBytes":disk_bytes,"entryCount":len(found),"fileCount":files,"maxDepth":max_depth,"schema":1,"treeDigest":hasher.hexdigest(),"uniqueInodes":len(identities)}
    if records: return summary,found,root_fd
    os.close(root_fd)
    return summary

def open_relative(root_fd,path,flags):
    parts=path.split(b"/")
    current=os.dup(root_fd)
    try:
        for part in parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=current)
            os.close(current); current=child
        result=os.open(parts[-1],flags,dir_fd=current)
        os.close(current)
        return result
    except:
        os.close(current); raise

def parent_fd(root_fd,path):
    parts=path.split(b"/")
    current=os.dup(root_fd)
    try:
        for part in parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=current)
            os.close(current); current=child
        return current,parts[-1]
    except:
        os.close(current); raise

def limits():
    resource.setrlimit(resource.RLIMIT_AS,(1073741824,1073741824))
    resource.setrlimit(resource.RLIMIT_CPU,(120,120))
    resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))

def evidence(path):
    descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    digest=hashlib.sha256(); size=0
    try:
        while True:
            chunk=os.read(descriptor,1048576)
            if not chunk: break
            size+=len(chunk)
            if size>MAX_PHYSICAL: fail("physical quota")
            digest.update(chunk)
    finally: os.close(descriptor)
    return {"bytes":size,"digest":digest.hexdigest()}

def preflight(path,max_bytes):
    proof=evidence(path)
    if proof["bytes"]<96 or proof["bytes"]>max_bytes: fail("archive size")
    with open(path,"rb",buffering=0) as archive: block=archive.read(96)
    values=struct.unpack("<5I6H8Q",block)
    magic,inodes,_,block_size,fragments,compression,block_log,_,no_ids,major,minor,*words=values
    root_inode,bytes_used,id_start,xattr_start,inode_start,directory_start,fragment_start,lookup_start=words
    if magic!=0x73717368 or major!=4 or minor!=0 or compression!=6: fail("archive format")
    if block_size<4096 or block_size>1048576 or block_size&(block_size-1) or block_log!=int(math.log2(block_size)): fail("block geometry")
    if inodes<1 or inodes>MAX_INODES or no_ids<1 or no_ids>65535 or fragments>MAX_INODES: fail("archive counts")
    if bytes_used<96 or bytes_used>proof["bytes"]: fail("bytes used")
    required=(id_start,inode_start,directory_start)
    optional=(xattr_start,fragment_start,lookup_start)
    if any(value<96 or value>=bytes_used for value in required): fail("table bounds")
    if any(value!=UINT64 and (value<96 or value>=bytes_used) for value in optional): fail("table bounds")
    if fragments and fragment_start==UINT64: fail("fragment table")
    root_block=root_inode>>16
    root_offset=root_inode&65535
    if root_offset>=8192 or inode_start+root_block<inode_start or inode_start+root_block>=directory_start: fail("root inode")
    return proof

def run(command,timeout=180,capture=False):
    return subprocess.run(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE if capture else subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=timeout,preexec_fn=limits)

def same_tree(left,right):
    fields=("schema","treeDigest","entryCount","uniqueInodes","fileCount","byteCount","maxDepth")
    return all(left.get(field)==right.get(field) for field in fields)

def mount_scan(helper,archive,mount,max_bytes,mode,staging=None,expected=None):
    command=["unshare","--mount","--propagation","private","--fork","python3",helper,mode,archive,mount,str(max_bytes)]
    if staging is not None: command.extend([staging,json.dumps(expected,separators=(",",":"),sort_keys=True)])
    result=run(command,capture=True)
    return json.loads(result.stdout)

def mounted(helper,archive,mount,max_bytes,staging=None,expected=None):
    preflight(archive,max_bytes)
    os.makedirs(mount,mode=0o700,exist_ok=False)
    process=subprocess.Popen(["squashfuse","-f","-o","ro,nodev,nosuid,noexec",archive,mount],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,preexec_fn=limits)
    try:
        deadline=time.monotonic()+10
        while not os.path.ismount(mount):
            if process.poll() is not None or time.monotonic()>deadline: fail("mount unavailable")
            time.sleep(.02)
        if staging is None: return scan_tree(mount,max_bytes)
        actual,records,source_fd=scan_tree(mount,max_bytes,True)
        if not same_tree(actual,expected): fail("tree evidence")
        try: copy_tree(source_fd,records,staging,max_bytes)
        finally: os.close(source_fd)
        restored=scan_tree(staging,max_bytes)
        if not same_tree(restored,expected): fail("restored evidence")
        return restored
    finally:
        for tool in ("fusermount3","fusermount"):
            if not os.path.ismount(mount): break
            try: subprocess.run([tool,"-u",mount],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False,timeout=10)
            except (FileNotFoundError,subprocess.TimeoutExpired): pass
        if process.poll() is None: process.kill()
        try: process.wait(timeout=10)
        except: pass
        if os.path.ismount(mount): fail("mount cleanup")
        shutil.rmtree(mount,ignore_errors=True)

def copy_tree(source_fd,records,staging,max_bytes):
    os.mkdir(staging,0o700)
    destination_fd=os.open(staging,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    first={}; actual=0
    try:
        for path,kind,device,inode,_,_,_,_ in records:
            if kind!=b"d": continue
            parent,name=parent_fd(destination_fd,path)
            try: os.mkdir(name,0o755,dir_fd=parent)
            finally: os.close(parent)
        for path,kind,device,inode,_,_,_,mode in records:
            if kind!=b"f": continue
            identity=(device,inode); parent,name=parent_fd(destination_fd,path)
            try:
                if identity in first:
                    old_parent,old_name=parent_fd(destination_fd,first[identity])
                    try: os.link(old_name,name,src_dir_fd=old_parent,dst_dir_fd=parent,follow_symlinks=False)
                    finally: os.close(old_parent)
                else:
                    source=open_relative(source_fd,path,os.O_RDONLY|os.O_NOFOLLOW)
                    target=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o755 if mode&0o111 else 0o644,dir_fd=parent)
                    try:
                        while True:
                            chunk=os.read(source,1048576)
                            if not chunk: break
                            actual+=len(chunk)
                            if actual>max_bytes: fail("copy byte quota")
                            view=memoryview(chunk)
                            while view: view=view[os.write(target,view):]
                    finally: os.close(source); os.close(target)
                    first[identity]=path
            finally: os.close(parent)
        for path,kind,_,_,_,_,target,_ in records:
            if kind!=b"l": continue
            parent,name=parent_fd(destination_fd,path)
            try: os.symlink(target,name,dir_fd=parent)
            finally: os.close(parent)
    except:
        os.close(destination_fd); shutil.rmtree(staging,ignore_errors=True); raise
    os.close(destination_fd)

def main():
    mode=sys.argv[1]
    if mode=="scan": result=scan_tree(sys.argv[2],int(sys.argv[3]))
    elif mode=="inspect":
        path=sys.argv[2]
        if not os.path.lexists(path): result={"state":"absent"}
        elif not os.path.isdir(path) or os.path.islink(path): fail("unsafe target")
        else: result={"state":"empty" if not os.listdir(path) else "nonempty"}
    elif mode=="preflight": result=preflight(sys.argv[2],int(sys.argv[3]))
    elif mode=="copy":
        source,staging,max_bytes=sys.argv[2],sys.argv[3],int(sys.argv[4])
        expected,records,source_fd=scan_tree(source,max_bytes,True)
        try: copy_tree(source_fd,records,staging,max_bytes)
        finally: os.close(source_fd)
        result=scan_tree(staging,max_bytes)
        if not same_tree(result,expected): fail("copied evidence")
    elif mode=="capture":
        target,archive,mount,max_bytes=sys.argv[2],sys.argv[3],sys.argv[4],int(sys.argv[5])
        before=scan_tree(target,max_bytes)
        try: os.unlink(archive)
        except FileNotFoundError: pass
        run(["mksquashfs",target,archive,"-comp","zstd","-noappend","-no-progress","-all-root","-no-xattrs","-no-exports","-mkfs-time","0","-all-time","0"])
        proof=preflight(archive,max_bytes)
        after=scan_tree(target,max_bytes)
        if before!=after: fail("source changed")
        mounted_summary=mount_scan(sys.argv[0],archive,mount,max_bytes,"mounted-scan")
        if not same_tree(before,mounted_summary): fail("archive tree changed")
        before["diskBytes"]=max(before["diskBytes"],mounted_summary["diskBytes"])
        result={**before,"archive":proof}
    elif mode=="mounted-scan": result=mounted(sys.argv[0],sys.argv[2],sys.argv[3],int(sys.argv[4]))
    elif mode=="restore":
        archive,mount,staging,max_bytes=sys.argv[2],sys.argv[3],sys.argv[4],int(sys.argv[5])
        expected=json.loads(sys.argv[6]); proof=preflight(archive,max_bytes)
        if proof!={"bytes":int(sys.argv[7]),"digest":sys.argv[8]}: fail("archive evidence")
        result=mount_scan(sys.argv[0],archive,mount,max_bytes,"mounted-restore",staging,expected)
    elif mode=="mounted-restore": result=mounted(sys.argv[0],sys.argv[2],sys.argv[3],int(sys.argv[4]),sys.argv[5],json.loads(sys.argv[6]))
    else: fail("invalid mode")
    print(json.dumps(result,separators=(",",":"),sort_keys=True))

def reason(error):
    message=str(error)
    if any(word in message for word in ("unsafe","escaping","special file","component","tree depth")): return "unsafe"
    if any(word in message for word in ("quota","archive size")): return "budget"
    if any(word in message for word in ("archive format","block geometry","archive counts","bytes used","table bounds","fragment table","root inode","archive evidence","tree evidence","restored evidence")): return "corrupt"
    return "unavailable"

try: main()
except Exception as error:
    mode=sys.argv[1] if len(sys.argv)>1 else ""
    if mode=="capture": print(json.dumps({"reason":reason(error),"state":"skipped"},separators=(",",":"),sort_keys=True))
    elif mode=="restore": print(json.dumps({"reason":reason(error),"state":"miss"},separators=(",",":"),sort_keys=True))
    else: sys.exit(1)
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
  return `timeout --signal=KILL ${timeoutSeconds}s prlimit --as=${HELPER_MEMORY_BYTES} --cpu=${cpuSeconds} --nofile=${HELPER_FILE_DESCRIPTORS} -- python3 ${shellQuote(helper)} ${mode} ${fields.map((field) => shellQuote(String(field))).join(" ")}`;
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
    const helper = `/tmp/.runway-cache-helper-${crypto.randomUUID()}.py`;
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
