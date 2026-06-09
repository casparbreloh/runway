import { createWorkflow, cron, hmacSha256, webhook } from "@runway/core";
import { expect, test } from "vitest";

import { createRouter } from "../src/router.ts";
import { createTestWorker } from "../src/testing.ts";

test("starts webhook and cron workflows in the Workers runtime", async () => {
  const seen: unknown[] = [];
  const hello = createWorkflow({
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
  const daily = createWorkflow({
    id: "daily",
    trigger: cron("0 9 * * *"),
  }).handler((ctx) => {
    seen.push(ctx.params);
  });
  const worker = createTestWorker([hello, daily], {
    secrets: { LINEAR_WEBHOOK_SECRET: "test-secret" },
  });

  const res = await worker.webhook("hello", { ok: true });
  await worker.scheduled("0 9 * * *", 42);
  await Promise.all(worker.executions);

  expect(res.status).toBe(202);
  expect(worker.runs).toEqual([
    { id: "hello-1", workflowId: "hello", params: { ok: true } },
    { id: "daily-2", workflowId: "daily", params: { cron: "0 9 * * *", scheduledTime: 42 } },
  ]);
  expect(seen).toEqual([{ ok: true }, { cron: "0 9 * * *", scheduledTime: 42 }]);
});

test("rejects unsigned webhooks before parsing the body", async () => {
  const calls: unknown[] = [];
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
        },
      },
    },
  ]);

  const res = await router.fetch(
    new Request("https://runway.test/hello", { method: "POST", body: "{" }),
    {
      LINEAR_WEBHOOK_SECRET: "test-secret",
      HELLO: {
        create: async ({ params }: { params: unknown }) => {
          calls.push(params);
          return { id: "run-1" };
        },
      },
    },
  );

  expect(res.status).toBe(401);
  expect(calls).toEqual([]);
});
