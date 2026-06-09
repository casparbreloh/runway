import assert from "node:assert/strict";
import test from "node:test";

import { createRouter, hmacSha256 } from "./router.ts";

const secret = "test-secret";

const router = createRouter([
  {
    id: "hello",
    binding: "HELLO",
    trigger: {
      type: "webhook",
      path: "/hello",
      auth: {
        type: "raw-hmac-sha256",
        header: "linear-signature",
        secret: "LINEAR_WEBHOOK_SECRET",
        timestamp: { source: "body", field: "webhookTimestamp", toleranceMs: 60_000 },
      },
    },
  },
  {
    id: "nightly",
    binding: "NIGHTLY",
    trigger: { type: "cron", cron: "0 9 * * *" },
  },
]);

const signed = async (body: string): Promise<Request> =>
  new Request("https://runway.test/hello", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "linear-signature": await hmacSha256(secret, body),
    },
  });

const env = (calls: unknown[]): Record<string, unknown> => ({
  LINEAR_WEBHOOK_SECRET: secret,
  HELLO: {
    create: async ({ params }: { params: unknown }) => {
      calls.push(params);
      return { id: "run-1" };
    },
  },
  NIGHTLY: {
    create: async ({ params }: { params: unknown }) => {
      calls.push(params);
      return { id: "run-2" };
    },
  },
});

void test("starts a workflow from a signed webhook", async () => {
  const calls: unknown[] = [];
  const body = JSON.stringify({ webhookTimestamp: Date.now(), ok: true });
  const res = await router.fetch(await signed(body), env(calls));
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { id: "run-1" });
  assert.deepEqual(calls, [{ webhookTimestamp: JSON.parse(body).webhookTimestamp, ok: true }]);
});

void test("rejects unsigned webhooks before parsing JSON", async () => {
  const calls: unknown[] = [];
  const res = await router.fetch(
    new Request("https://runway.test/hello", { method: "POST", body: "{" }),
    env(calls),
  );
  assert.equal(res.status, 401);
  assert.deepEqual(calls, []);
});

void test("returns a clear error when a required secret is not bound", async () => {
  const calls: unknown[] = [];
  const body = JSON.stringify({ webhookTimestamp: Date.now() });
  const res = await router.fetch(await signed(body), { HELLO: env(calls).HELLO });
  assert.equal(res.status, 500);
  assert.equal(await res.text(), "no secret: LINEAR_WEBHOOK_SECRET");
});

void test("rejects stale signed webhooks", async () => {
  const calls: unknown[] = [];
  const body = JSON.stringify({ webhookTimestamp: Date.now() - 120_000 });
  const res = await router.fetch(await signed(body), env(calls));
  assert.equal(res.status, 401);
  assert.deepEqual(calls, []);
});

void test("starts workflows from cron events", async () => {
  const calls: unknown[] = [];
  await router.scheduled({ cron: "0 9 * * *", scheduledTime: 42 }, env(calls));
  assert.deepEqual(calls, [{ cron: "0 9 * * *", scheduledTime: 42 }]);
});
