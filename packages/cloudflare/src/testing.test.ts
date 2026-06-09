import { createTestWorker } from "@runway/cloudflare/testing";
import { createWorkflow, cron, hmacSha256, webhook } from "@runway/core";
import { expect, test } from "vitest";

test("test worker starts a signed webhook workflow and runs its handler", async () => {
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

  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ id: "hello-1" });
  await worker.executions[0];
  expect(worker.runs).toEqual([{ id: "hello-1", workflowId: "hello", params: { ok: true } }]);
  expect(seen).toEqual([{ ok: true }]);
});

test("test worker starts cron workflows", async () => {
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

  expect(worker.runs).toEqual([
    { id: "daily-1", workflowId: "daily", params: { cron: "0 9 * * *", scheduledTime: 42 } },
  ]);
  expect(seen).toEqual([{ cron: "0 9 * * *", scheduledTime: 42 }]);
});
