import { createWorkflow, cron, hmacSha256, webhook } from "@runway/core";
import { expect, test } from "vitest";

import { createRouter } from "../src/router.ts";
import { createTestWorker } from "./worker.ts";

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
    secrets: ["LINEAR_API_KEY"],
  }).handler(async (ctx) => {
    seen.push(
      await ctx.step("record", () => ({ key: ctx.secrets.LINEAR_API_KEY, params: ctx.params })),
    );
    await ctx.sleep(10);
  });
  const daily = createWorkflow({
    id: "daily",
    trigger: cron("0 9 * * *"),
  }).handler((ctx) => {
    // @ts-expect-error secrets must be declared on the workflow
    void ctx.secrets.LINEAR_API_KEY;
    seen.push(ctx.params);
  });
  const worker = createTestWorker([hello, daily], {
    secrets: { LINEAR_WEBHOOK_SECRET: "test-secret", LINEAR_API_KEY: "lin_api_test" },
  });

  const res = await worker.webhook("hello", { ok: true });
  await worker.scheduled("0 9 * * *", 42);
  await Promise.all(worker.executions);

  expect(res.status).toBe(202);
  expect(worker.runs).toEqual([
    { id: "hello-1", workflowId: "hello", params: { ok: true } },
    { id: "daily-2", workflowId: "daily", params: { cron: "0 9 * * *", scheduledTime: 42 } },
  ]);
  expect(seen).toEqual([
    { key: "lin_api_test", params: { ok: true } },
    { cron: "0 9 * * *", scheduledTime: 42 },
  ]);
});

test("verifies prefixed signatures and rejects stale timestamps", async () => {
  const stamped = createWorkflow({
    id: "stamped",
    trigger: webhook({
      path: "/stamped",
      auth: hmacSha256({
        header: "x-hub-signature-256",
        secret: "GITHUB_WEBHOOK_SECRET",
        prefix: "sha256=",
        timestamp: { field: "webhookTimestamp", toleranceMs: 60_000 },
      }),
    }),
  }).handler(async () => {});
  const worker = createTestWorker([stamped], {
    secrets: { GITHUB_WEBHOOK_SECRET: "test-secret" },
  });

  const fresh = await worker.webhook("stamped", { webhookTimestamp: Date.now() });
  const stale = await worker.webhook("stamped", { webhookTimestamp: Date.now() - 120_000 });

  expect(fresh.status).toBe(202);
  expect(stale.status).toBe(401);
  expect(worker.runs).toHaveLength(1);
});

test("accepts the webhook but fails the run when a declared secret is missing", async () => {
  const needy = createWorkflow({
    id: "needy",
    trigger: webhook({
      path: "/needy",
      auth: hmacSha256({ header: "x-signature", secret: "NEEDY_WEBHOOK_SECRET" }),
    }),
    secrets: ["NEEDY_API_KEY"],
  }).handler(async (ctx) => {
    void ctx.secrets.NEEDY_API_KEY;
  });
  const worker = createTestWorker([needy], {
    secrets: { NEEDY_WEBHOOK_SECRET: "test-secret" },
  });

  const res = await worker.webhook("needy");

  expect(res.status).toBe(202);
  await expect(worker.executions[0]).rejects.toThrow("missing secret: NEEDY_API_KEY");
});

test("rejects unsigned webhooks before parsing the body", async () => {
  const calls: unknown[] = [];
  const router = createRouter([
    {
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
