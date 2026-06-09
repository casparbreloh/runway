import assert from "node:assert/strict";
import { test } from "node:test";

import { createTestWorker } from "@runway/cloudflare/testing";

import hello from "./hello.ts";

void test("hello starts from a signed webhook locally", async () => {
  const worker = createTestWorker([hello], {
    secrets: { LINEAR_WEBHOOK_SECRET: "test-secret" },
  });
  const payload = { webhookTimestamp: Date.now(), issue: "RUN-1" };

  const res = await worker.webhook("hello", payload);

  assert.equal(res.status, 202);
  await worker.executions[0];
  assert.deepEqual(worker.runs, [
    {
      id: "hello-1",
      workflowId: "hello",
      params: payload,
    },
  ]);
});
