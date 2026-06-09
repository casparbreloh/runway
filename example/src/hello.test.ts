import { createTestWorker } from "@runway/cloudflare/testing";
import { expect, test } from "vitest";

import hello from "./hello.ts";

test("hello starts from a signed webhook locally", async () => {
  const worker = createTestWorker([hello], {
    secrets: { LINEAR_WEBHOOK_SECRET: "test-secret" },
  });
  const payload = { webhookTimestamp: Date.now(), issue: "RUN-1" };

  const res = await worker.webhook("hello", payload);

  expect(res.status).toBe(202);
  await worker.executions[0];
  expect(worker.runs).toEqual([
    {
      id: "hello-1",
      workflowId: "hello",
      params: payload,
    },
  ]);
});
