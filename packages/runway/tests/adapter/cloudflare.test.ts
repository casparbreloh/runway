import { expect, test, vi } from "vitest";

import { defaultClient } from "../../src/internal/cloudflare.ts";

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
