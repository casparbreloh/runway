import { expect, test, vi } from "vitest";

import { defaultClient } from "../../src/internal/cloudflare.ts";

test("Worker uploads use Cloudflare's filename-addressed multipart format", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ success: true, result: { id: "runway" } }));
  const file = new File(["export default { fetch() {} };"], "worker.js", {
    type: "application/javascript+module",
  });

  await expect(
    defaultClient("token", request).workers.scripts.update("runway", {
      account_id: "account",
      metadata: { main_module: "worker.js" },
      files: [file],
    }),
  ).resolves.toEqual({ id: "runway" });

  const [url, init] = request.mock.calls[0]!;
  expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/runway");
  expect(init?.method).toBe("PUT");
  expect(init?.headers).toEqual({ authorization: "Bearer token" });
  const form = init?.body as FormData;
  expect(form.get("metadata")).toBe('{"main_module":"worker.js"}');
  expect(form.get("files[]")).toBeNull();
  const uploaded = form.get("worker.js") as File;
  expect(uploaded.name).toBe("worker.js");
  expect(uploaded.type).toBe("application/javascript+module");
  expect(await uploaded.text()).toBe("export default { fetch() {} };");
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
