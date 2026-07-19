import { expect, test, vi } from "vitest";

import { cloudflare7Compatibility, defaultClient } from "../../src/internal/cloudflare.ts";

const compatibilitySource = () => {
  const scriptList = vi.fn(async () => "scripts");
  const versionGet = vi.fn(async () => "version");
  const bucketList = vi.fn(async () => "buckets");
  const upload = vi.fn(async () => "uploaded");
  const get = vi.fn(async () => "object");
  const deleteObject = vi.fn(async () => "deleted");
  const source = {
    workers: {
      routes: {},
      scripts: {
        list: scriptList,
        versions: { get: versionGet },
      },
    },
    r2: {
      buckets: {
        list: bucketList,
        objects: { upload, get, delete: deleteObject },
      },
    },
  } as unknown as Parameters<typeof cloudflare7Compatibility>[0];

  return {
    client: cloudflare7Compatibility(source),
    scriptList,
    versionGet,
    bucketList,
    upload,
    get,
    deleteObject,
  };
};

test("Cloudflare 7 worker compatibility inherits methods and maps version get", async () => {
  const { client, scriptList, versionGet } = compatibilitySource();

  await expect(client.workers.scripts.list({ account_id: "account" })).resolves.toBe("scripts");
  await expect(
    client.workers.scripts.versions.get("script", "version", { account_id: "account" }),
  ).resolves.toBe("version");

  expect(scriptList).toHaveBeenCalledWith({ account_id: "account" });
  expect(versionGet).toHaveBeenCalledWith("version", {
    account_id: "account",
    script_name: "script",
  });
});

test("Cloudflare 7 R2 compatibility inherits methods and maps object operations", async () => {
  const { client, bucketList, upload, get, deleteObject } = compatibilitySource();
  const body = new Uint8Array([1, 2, 3]);
  const options = { headers: { "content-type": "application/octet-stream" } };

  await expect(client.r2.buckets.list({ account_id: "account" })).resolves.toBe("buckets");
  await expect(
    client.r2.buckets.objects.upload("bucket", "key", body, { account_id: "account" }, options),
  ).resolves.toBe("uploaded");
  await expect(
    client.r2.buckets.objects.get("bucket", "key", { account_id: "account" }),
  ).resolves.toBe("object");
  await expect(
    client.r2.buckets.objects.delete("bucket", "key", { account_id: "account" }),
  ).resolves.toBe("deleted");

  expect(bucketList).toHaveBeenCalledWith({ account_id: "account" });
  expect(upload).toHaveBeenCalledWith(
    "key",
    body,
    { account_id: "account", bucket_name: "bucket" },
    options,
  );
  expect(get).toHaveBeenCalledWith("key", {
    account_id: "account",
    bucket_name: "bucket",
  });
  expect(deleteObject).toHaveBeenCalledWith("key", {
    account_id: "account",
    bucket_name: "bucket",
  });
});

test("Containers GET retries bounded transport and server failures", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
    .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
    .mockResolvedValueOnce(Response.json([{ id: "application" }]));

  await expect(
    defaultClient("token", request).containers.applications.list({ account_id: "account" }),
  ).resolves.toEqual([{ id: "application" }]);
  expect(request).toHaveBeenCalledTimes(3);
  expect(request.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
});

test("Containers mutations never retry an ambiguous transport failure", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new DOMException("timed out", "TimeoutError"));

  await expect(
    defaultClient("token", request).containers.applications.create({
      account_id: "account",
      body: { name: "runway" },
    }),
  ).rejects.toThrow("request failed");
  expect(request).toHaveBeenCalledOnce();
});
