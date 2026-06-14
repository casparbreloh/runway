import type { StandardSchemaV1 } from "@standard-schema/spec";
import { cron, webhook, workflow } from "runway";
import { expect, test } from "vitest";

import { createRouter, hmacSha256Hex } from "../src/router.ts";
import { createTestWorker } from "./worker.ts";

const issueCreated: StandardSchemaV1<unknown, { action: string; normalized: boolean }> = {
  "~standard": {
    version: 1,
    vendor: "runway-test",
    validate: (value) => {
      const event = value as { action?: unknown };
      return event.action === "create"
        ? {
            value: { ...(value as Record<string, unknown>), action: "create", normalized: true },
          }
        : { issues: [{ message: "not an issue create" }] };
    },
  },
};

test("starts webhook and cron workflows in the Workers runtime", async () => {
  const seen: unknown[] = [];
  const hello = workflow({
    id: "hello",
    secrets: ["LINEAR_WEBHOOK_SECRET", "LINEAR_API_KEY"],
    trigger: (tctx) =>
      webhook({
        path: "/hello",
        secret: tctx.secrets.LINEAR_WEBHOOK_SECRET,
        signatureHeader: "linear-signature",
      }),
  }).handler(async (ctx, event) => {
    seen.push(await ctx.step("record", () => ({ key: ctx.secrets.LINEAR_API_KEY, params: event })));
    await ctx.sleep(10);
  });
  const daily = workflow({ id: "daily", trigger: () => cron("0 9 * * *") }).handler(
    (ctx, event) => {
      // @ts-expect-error secrets must be declared on the workflow
      void ctx.secrets.LINEAR_API_KEY;
      seen.push(event);
    },
  );
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

test("a webhook event failing schema validation responds skipped and starts no run", async () => {
  const review = workflow({
    id: "review",
    secrets: ["HOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/review",
        secret: tctx.secrets.HOOK_SECRET,
        signatureHeader: "x-signature",
        schema: issueCreated,
      }),
  }).handler(async () => {});
  const worker = createTestWorker([review], { secrets: { HOOK_SECRET: "test-secret" } });

  const res = await worker.webhook("review", { action: "update" });

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ skipped: true });
  expect(worker.runs).toEqual([]);
});

test("a passing webhook event starts a run whose handler event is the validate output", async () => {
  const seen: unknown[] = [];
  const review = workflow({
    id: "review",
    secrets: ["HOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/review",
        secret: tctx.secrets.HOOK_SECRET,
        signatureHeader: "x-signature",
        schema: issueCreated,
      }),
  }).handler(async (_ctx, event) => {
    seen.push(event);
  });
  const worker = createTestWorker([review], { secrets: { HOOK_SECRET: "test-secret" } });

  const res = await worker.webhook("review", { action: "create" });
  await Promise.all(worker.executions);

  expect(res.status).toBe(202);
  expect(worker.runs).toEqual([
    { id: "review-1", workflowId: "review", params: { action: "create", normalized: true } },
  ]);
  expect(seen).toEqual([{ action: "create", normalized: true }]);
});

test("an async schema validate is awaited before gating the run", async () => {
  const asyncSchema: StandardSchemaV1<unknown, { action: string; vetted: boolean }> = {
    "~standard": {
      version: 1,
      vendor: "runway-test",
      validate: async (value) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const event = value as { action?: unknown };
        return event.action === "create"
          ? { value: { ...(value as Record<string, unknown>), action: "create", vetted: true } }
          : { issues: [{ message: "not an issue create" }] };
      },
    },
  };
  const review = workflow({
    id: "review",
    secrets: ["HOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/review",
        secret: tctx.secrets.HOOK_SECRET,
        signatureHeader: "x-signature",
        schema: asyncSchema,
      }),
  }).handler(async () => {});
  const worker = createTestWorker([review], { secrets: { HOOK_SECRET: "test-secret" } });

  const skipped = await worker.webhook("review", { action: "update" });
  const started = await worker.webhook("review", { action: "create" });

  expect(skipped.status).toBe(200);
  expect(await skipped.json()).toEqual({ skipped: true });
  expect(started.status).toBe(202);
  expect(worker.runs).toEqual([
    { id: "review-1", workflowId: "review", params: { action: "create", vetted: true } },
  ]);
});

test("the filter predicate runs on the schema output and gates the run", async () => {
  const predicateSaw: unknown[] = [];
  const review = workflow({
    id: "review",
    secrets: ["HOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/review",
        secret: tctx.secrets.HOOK_SECRET,
        signatureHeader: "x-signature",
        schema: issueCreated,
      }).filter((event): event is { action: string; normalized: boolean; urgent: true } => {
        predicateSaw.push(event);
        return (event as { urgent?: unknown }).urgent === true;
      }),
  }).handler(async () => {});
  const worker = createTestWorker([review], { secrets: { HOOK_SECRET: "test-secret" } });

  const skipped = await worker.webhook("review", { action: "create", urgent: false });
  const started = await worker.webhook("review", { action: "create", urgent: true });

  expect(skipped.status).toBe(200);
  expect(await skipped.json()).toEqual({ skipped: true });
  expect(started.status).toBe(202);
  expect(predicateSaw).toEqual([
    { action: "create", urgent: false, normalized: true },
    { action: "create", urgent: true, normalized: true },
  ]);
  expect(worker.runs).toEqual([
    {
      id: "review-1",
      workflowId: "review",
      params: { action: "create", urgent: true, normalized: true },
    },
  ]);
});

test("a rejecting schema validate responds 500 and starts no run", async () => {
  const broken: StandardSchemaV1<unknown, unknown> = {
    "~standard": {
      version: 1,
      vendor: "runway-test",
      validate: () => Promise.reject(new Error("schema exploded")),
    },
  };
  const review = workflow({
    id: "review",
    secrets: ["HOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/review",
        secret: tctx.secrets.HOOK_SECRET,
        signatureHeader: "x-signature",
        schema: broken,
      }),
  }).handler(async () => {});
  const worker = createTestWorker([review], { secrets: { HOOK_SECRET: "test-secret" } });

  const res = await worker.webhook("review", { action: "create" });

  expect(res.status).toBe(500);
  expect(worker.runs).toEqual([]);
});

test("a throwing entry on a shared path responds 500 and starts no runs at all", async () => {
  const passing = workflow({
    id: "passing",
    secrets: ["HOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/linear",
        secret: tctx.secrets.HOOK_SECRET,
        signatureHeader: "x-signature",
      }),
  }).handler(async () => {});
  const exploding = workflow({
    id: "exploding",
    secrets: ["HOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/linear",
        secret: tctx.secrets.HOOK_SECRET,
        signatureHeader: "x-signature",
      }).filter((_event): _event is { action: "create" } => {
        throw new Error("predicate exploded");
      }),
  }).handler(async () => {});
  const worker = createTestWorker([passing, exploding], {
    secrets: { HOOK_SECRET: "test-secret" },
  });

  const res = await worker.webhook("passing", { action: "create" });

  expect(res.status).toBe(500);
  expect(worker.runs).toEqual([]);
});

test("two workflows sharing one path verify once and fan out per-entry", async () => {
  const issues = workflow({
    id: "issues",
    secrets: ["HOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/linear",
        secret: tctx.secrets.HOOK_SECRET,
        signatureHeader: "x-signature",
        schema: issueCreated,
      }),
  }).handler(async () => {});
  const urgent = workflow({
    id: "urgent",
    secrets: ["HOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/linear",
        secret: tctx.secrets.HOOK_SECRET,
        signatureHeader: "x-signature",
      }).filter(
        (event): event is { urgent: true } => (event as { urgent?: unknown }).urgent === true,
      ),
  }).handler(async () => {});
  const worker = createTestWorker([issues, urgent], {
    secrets: { HOOK_SECRET: "test-secret" },
  });

  const both = await worker.webhook("issues", { action: "create", urgent: true });
  const one = await worker.webhook("issues", { action: "create", urgent: false });
  const none = await worker.webhook("issues", { action: "update", urgent: false });

  expect(both.status).toBe(202);
  expect(await both.json()).toEqual({
    runs: [
      { id: "issues-1", workflow: "issues" },
      { id: "urgent-2", workflow: "urgent" },
    ],
  });
  expect(one.status).toBe(202);
  expect(await one.json()).toEqual({ runs: [{ id: "issues-3", workflow: "issues" }] });
  expect(none.status).toBe(200);
  expect(await none.json()).toEqual({ skipped: true });
  expect(worker.runs).toEqual([
    {
      id: "issues-1",
      workflowId: "issues",
      params: { action: "create", urgent: true, normalized: true },
    },
    { id: "urgent-2", workflowId: "urgent", params: { action: "create", urgent: true } },
    {
      id: "issues-3",
      workflowId: "issues",
      params: { action: "create", urgent: false, normalized: true },
    },
  ]);
});

test("verifies prefixed signatures and header timestamps in unix seconds", async () => {
  const stamped = workflow({
    id: "stamped",
    secrets: ["GITHUB_WEBHOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/stamped",
        secret: tctx.secrets.GITHUB_WEBHOOK_SECRET,
        signatureHeader: "x-hub-signature-256",
        prefix: "sha256=",
        timestamp: { source: "header", field: "x-runway-timestamp", toleranceMs: 60_000 },
      }),
  }).handler(async () => {});
  const worker = createTestWorker([stamped], {
    secrets: { GITHUB_WEBHOOK_SECRET: "test-secret" },
  });

  const fresh = await worker.webhook("stamped", {}, { timestamp: Math.floor(Date.now() / 1000) });
  const stale = await worker.webhook(
    "stamped",
    {},
    { timestamp: Math.floor(Date.now() / 1000) - 120 },
  );

  expect(fresh.status).toBe(202);
  expect(stale.status).toBe(401);
  expect(worker.runs).toHaveLength(1);
});

test("accepts the webhook but fails the run when a declared secret is missing", async () => {
  const needy = workflow({
    id: "needy",
    secrets: ["NEEDY_WEBHOOK_SECRET", "NEEDY_API_KEY"],
    trigger: (tctx) =>
      webhook({
        path: "/needy",
        secret: tctx.secrets.NEEDY_WEBHOOK_SECRET,
        signatureHeader: "x-signature",
      }),
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

test("a signed but malformed json body responds 400 and starts no run", async () => {
  const calls: unknown[] = [];
  const hello = workflow({
    id: "hello",
    secrets: ["LINEAR_WEBHOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/hello",
        secret: tctx.secrets.LINEAR_WEBHOOK_SECRET,
        signatureHeader: "linear-signature",
      }),
  }).handler(async () => {});
  const router = createRouter([{ id: "hello", binding: "HELLO", trigger: hello.trigger }]);
  const body = "{";

  const res = await router.fetch(
    new Request("https://runway.test/hello", {
      method: "POST",
      body,
      headers: { "linear-signature": await hmacSha256Hex("test-secret", body) },
    }),
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

  expect(res.status).toBe(400);
  expect(calls).toEqual([]);
});

test("verifies webhooks using scoped secret bindings", async () => {
  const calls: unknown[] = [];
  const hello = workflow({
    id: "hello",
    secrets: ["LINEAR_WEBHOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/hello",
        secret: tctx.secrets.LINEAR_WEBHOOK_SECRET,
        signatureHeader: "linear-signature",
      }),
  }).handler(async () => {});
  const router = createRouter([
    {
      id: "hello",
      binding: "HELLO",
      trigger: hello.trigger,
      secretBindings: {
        LINEAR_WEBHOOK_SECRET: [
          "LINEAR_WEBHOOK_SECRET",
          "RUNWAY_WORKFLOW_HELLO_LINEAR_WEBHOOK_SECRET",
          "RUNWAY_PROJECT_LINEAR_WEBHOOK_SECRET",
          "RUNWAY_GLOBAL_LINEAR_WEBHOOK_SECRET",
        ],
      },
    },
  ]);
  const body = JSON.stringify({ ok: true });

  const res = await router.fetch(
    new Request("https://runway.test/hello", {
      method: "POST",
      body,
      headers: { "linear-signature": await hmacSha256Hex("test-secret", body) },
    }),
    {
      RUNWAY_PROJECT_LINEAR_WEBHOOK_SECRET: "test-secret",
      HELLO: {
        create: async ({ params }: { params: unknown }) => {
          calls.push(params);
          return { id: "run-1" };
        },
      },
    },
  );

  expect(res.status).toBe(202);
  expect(calls).toEqual([{ ok: true }]);
});

test("rejects unsigned webhooks before parsing the body", async () => {
  const calls: unknown[] = [];
  const hello = workflow({
    id: "hello",
    secrets: ["LINEAR_WEBHOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/hello",
        secret: tctx.secrets.LINEAR_WEBHOOK_SECRET,
        signatureHeader: "linear-signature",
      }),
  }).handler(async () => {});
  const router = createRouter([{ id: "hello", binding: "HELLO", trigger: hello.trigger }]);

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
