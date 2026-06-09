import assert from "node:assert/strict";
import { test } from "node:test";

import { createTestWorker } from "@runway/cloudflare/testing";
import { createWorkflow, cron, hmacSha256, webhook } from "@runway/core";

void test("test worker starts a signed webhook workflow and runs its handler", async () => {
  const seen: unknown[] = [];
  const workflow = createWorkflow({
    id: "hello",
    trigger: webhook({
      path: "/hello",
      auth: hmacSha256({
        header: "linear-signature",
        secret: "LINEAR_WEBHOOK_SECRET",
      }),
    }),
  }).handler(async (ctx) => {
    seen.push(await ctx.step("record", () => ctx.params));
    await ctx.sleep(10);
  });
  const worker = createTestWorker([workflow], {
    secrets: { LINEAR_WEBHOOK_SECRET: "test-secret" },
  });

  const res = await worker.webhook("hello", { ok: true });

  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { id: "hello-1" });
  await worker.executions[0];
  assert.deepEqual(worker.runs, [{ id: "hello-1", workflowId: "hello", params: { ok: true } }]);
  assert.deepEqual(seen, [{ ok: true }]);
});

void test("test worker returns 202 before handler execution settles", async () => {
  let release!: () => void;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const workflow = createWorkflow({
    id: "hello",
    trigger: webhook({
      path: "/hello",
      auth: hmacSha256({ header: "linear-signature", secret: "LINEAR_WEBHOOK_SECRET" }),
    }),
  }).handler(() => finished);
  const worker = createTestWorker([workflow], {
    secrets: { LINEAR_WEBHOOK_SECRET: "test-secret" },
  });

  const res = await worker.webhook("hello", {});

  assert.equal(res.status, 202);
  release();
  await worker.executions[0];
});

void test("test worker supports header timestamp webhooks", async () => {
  const workflow = createWorkflow({
    id: "hello",
    trigger: webhook({
      path: "/hello",
      auth: hmacSha256({
        header: "x-signature",
        secret: "WEBHOOK_SECRET",
        timestamp: { source: "header", field: "x-timestamp", toleranceMs: 60_000 },
      }),
    }),
  }).handler(() => {});
  const worker = createTestWorker([workflow], {
    secrets: { WEBHOOK_SECRET: "test-secret" },
  });

  const res = await worker.webhook("hello", {});

  assert.equal(res.status, 202);
});

void test("test worker starts cron workflows", async () => {
  const seen: unknown[] = [];
  const workflow = createWorkflow({
    id: "daily",
    trigger: cron("0 9 * * *"),
  }).handler((ctx) => {
    seen.push(ctx.params);
  });
  const worker = createTestWorker([workflow]);

  await worker.scheduled("0 9 * * *", 42);
  await worker.executions[0];

  assert.deepEqual(worker.runs, [
    { id: "daily-1", workflowId: "daily", params: { cron: "0 9 * * *", scheduledTime: 42 } },
  ]);
  assert.deepEqual(seen, [{ cron: "0 9 * * *", scheduledTime: 42 }]);
});
