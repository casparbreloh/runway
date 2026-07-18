import { expect, test } from "vitest";

import {
  CloudflareCacheTransfer,
  type CacheTransferCapability,
  type CacheTransferSession,
} from "../../src/internal/cache/transfer.ts";

const archiveDigest = "95ff92053b19ae8bfea5ad1b1a8bb52b4d2e6793cba471f8588a864fdb53c0ed";
const archiveBytes = new TextEncoder().encode("cache-v1");
const differentDigest = "a2d1fbb19c1008738d296af40bbc731a6457fee5def4ee34b7c7e5045bd683df";

interface StoredObject {
  readonly body: Uint8Array;
  readonly bytes: number;
  readonly digest: string;
}

class MemoryTransfer {
  readonly capabilities: CacheTransferCapability[] = [];
  readonly files = new Map<string, Uint8Array>([["/cache/archive.sqsh", archiveBytes]]);
  readonly objects = new Map<string, StoredObject>();
  readonly events: string[] = [];
  digest = archiveDigest;

  async quiesce(): Promise<CacheTransferSession> {
    this.events.push("quiesced");
    let closed = false;
    const assertOpen = (): void => {
      if (closed) throw new Error("transfer session is closed");
    };
    return {
      inspect: async (path) => {
        assertOpen();
        this.events.push("inspected");
        const body = this.files.get(path);
        if (!body) throw new Error("archive is missing");
        return { bytes: body.byteLength, digest: this.digest };
      },
      upload: async ({ path, capability }) => {
        assertOpen();
        this.events.push("uploaded");
        this.capabilities.push(capability);
        const body = this.files.get(path);
        if (!body) throw new Error("archive is missing");
        const key = keyOf(capability);
        if (this.objects.has(key) && capability.headers["if-none-match"] === "*") {
          return "precondition-failed";
        }
        this.objects.set(key, {
          body: body.slice(),
          bytes: body.byteLength,
          digest: capability.headers["x-amz-meta-runway-sha256"]!,
        });
        return "stored";
      },
      download: async ({ path, capability }) => {
        assertOpen();
        this.events.push("downloaded");
        this.capabilities.push(capability);
        const object = this.objects.get(keyOf(capability));
        if (!object) throw new Error("object is missing");
        this.files.set(path, object.body.slice());
        return { bytes: object.bytes, digest: object.digest };
      },
      close: async () => {
        closed = true;
        this.events.push("closed");
      },
    };
  }

  async head(
    key: string,
  ): Promise<{ readonly bytes: number; readonly digest: string } | undefined> {
    this.events.push("verified");
    return this.objects.get(key);
  }
}

const keyOf = (capability: CacheTransferCapability): string => {
  const url = new URL(capability.url);
  expect(url.protocol).toBe("https:");
  expect(url.host).toBe("account.r2.cloudflarestorage.com");
  expect(url.pathname).toBe("/runway-cache/content/exact%20archive.sqsh");
  expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
  expect(Number(url.searchParams.get("X-Amz-Date")?.slice(0, 8))).toBe(20260716);
  return decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
};

test("a quiescent Sandbox transfers one exact verified archive directly through R2 capabilities", async () => {
  const remote = new MemoryTransfer();
  const logs: unknown[] = [];
  const transfer = new CloudflareCacheTransfer({
    accountId: "account",
    bucket: "runway-cache",
    accessKeyId: "ACCESS_KEY_MUST_NOT_ESCAPE",
    secretAccessKey: "SECRET_KEY_MUST_NOT_ESCAPE",
    expiresInSeconds: 120,
    now: () => new Date("2026-07-16T12:34:56.000Z"),
    transport: remote,
    objects: remote,
    log: (entry) => logs.push(entry),
  });

  const uploaded = await transfer.put({
    runId: "run-1",
    key: "content/exact archive.sqsh",
    path: "/cache/archive.sqsh",
  });
  remote.files.delete("/cache/archive.sqsh");
  const downloaded = await transfer.get({
    runId: "run-1",
    key: "content/exact archive.sqsh",
    path: "/cache/archive.sqsh",
    expected: { bytes: archiveBytes.byteLength, digest: archiveDigest },
  });

  const put = remote.capabilities[0]!;
  expect(put.method).toBe("PUT");
  expect(put.headers).toMatchObject({
    "content-length": String(archiveBytes.byteLength),
    "if-none-match": "*",
    "x-amz-meta-runway-run": "run-1",
    "x-amz-meta-runway-sha256": archiveDigest,
  });
  expect(new URL(put.url).searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
    expect.arrayContaining([
      "content-length",
      "host",
      "if-none-match",
      "x-amz-meta-runway-run",
      "x-amz-meta-runway-sha256",
    ]),
  );
  expect(remote.capabilities[1]?.method).toBe("GET");
  expect({ uploaded, downloaded }).toEqual({
    uploaded: { state: "stored", bytes: archiveBytes.byteLength, digest: archiveDigest },
    downloaded: { bytes: archiveBytes.byteLength, digest: archiveDigest },
  });
  expect(remote.files.get("/cache/archive.sqsh")).toEqual(archiveBytes);
  expect(remote.events).toEqual([
    "quiesced",
    "inspected",
    "uploaded",
    "verified",
    "closed",
    "verified",
    "quiesced",
    "downloaded",
    "closed",
  ]);
  expect(JSON.stringify({ uploaded, downloaded, logs })).not.toMatch(
    /ACCESS_KEY_MUST_NOT_ESCAPE|SECRET_KEY_MUST_NOT_ESCAPE|X-Amz-/,
  );
});

test("a repeated conditional PUT cannot replace immutable cache content", async () => {
  const remote = new MemoryTransfer();
  const transfer = new CloudflareCacheTransfer({
    accountId: "account",
    bucket: "runway-cache",
    accessKeyId: "access",
    secretAccessKey: "secret",
    expiresInSeconds: 120,
    now: () => new Date("2026-07-16T12:34:56.000Z"),
    transport: remote,
    objects: remote,
  });
  const request = {
    runId: "run-immutable",
    key: "content/exact archive.sqsh",
    path: "/cache/archive.sqsh",
  };

  await expect(transfer.put(request)).resolves.toMatchObject({ state: "stored" });
  await expect(transfer.put(request)).resolves.toEqual({
    state: "present",
    bytes: archiveBytes.byteLength,
    digest: archiveDigest,
  });
  remote.files.set(request.path, new TextEncoder().encode("cache-v2-different"));
  remote.digest = differentDigest;
  await expect(transfer.put(request)).rejects.toThrow("uploaded cache archive failed verification");

  expect(remote.objects.get(request.key)).toEqual({
    body: archiveBytes,
    bytes: archiveBytes.byteLength,
    digest: archiveDigest,
  });
  expect(
    remote.capabilities.slice(1).every(({ headers }) => headers["if-none-match"] === "*"),
  ).toBe(true);
});

test("a failed transfer cannot expose its bearer capability through errors or logs", async () => {
  const remote = new MemoryTransfer();
  const base = remote.quiesce.bind(remote);
  remote.quiesce = async () => {
    const session = await base();
    return {
      ...session,
      upload: async ({ capability }) => {
        throw new Error(`upstream rejected ${capability.url}`);
      },
    };
  };
  const logs: unknown[] = [];
  const transfer = new CloudflareCacheTransfer({
    accountId: "account",
    bucket: "runway-cache",
    accessKeyId: "LEAKING_ACCESS_KEY",
    secretAccessKey: "LEAKING_SECRET_KEY",
    sessionToken: "LEAKING_SESSION_TOKEN",
    expiresInSeconds: 120,
    transport: remote,
    objects: remote,
    log: (entry) => logs.push(entry),
  });

  let failure: unknown;
  try {
    await transfer.put({
      runId: "run-private",
      key: "content/exact archive.sqsh",
      path: "/cache/archive.sqsh",
    });
  } catch (error) {
    failure = error;
  }

  expect(failure).toMatchObject({
    name: "CacheTransferError",
    message: "cache archive transfer failed",
  });
  expect(JSON.stringify({ failure, logs })).not.toMatch(/LEAKING_|X-Amz-|cloudflarestorage\.com/);
  expect(remote.events.at(-1)).toBe("closed");
});
