import { createExecutionContext, introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, test } from "vitest";

import worker from "./runtime-worker.ts";

const signatureOf = async (body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("test-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const webhook = async (body: string, signature = signatureOf(body)): Promise<Response> =>
  exports.default.fetch("https://runway.test/issues", {
    method: "POST",
    headers: { "x-signature": await signature },
    body,
  });

test("a signed webhook runs a durable workflow in the Workers runtime", async () => {
  const introspector = await introspectWorkflow(env.ISSUE_CREATED);
  try {
    const response = await webhook(JSON.stringify({ action: "create" }));
    const payload = (await response.json()) as {
      runs: [{ id: string; workflow: string }];
    };
    const [instance] = introspector.get();

    expect(response.status).toBe(202);
    expect(payload.runs[0]?.workflow).toBe("issue-created");
    expect(await instance!.waitForStepResult({ name: "record-issue" })).toEqual({
      stepId: "record-issue",
      runId: payload.runs[0]!.id,
      apiKey: "test-api-key",
      event: { action: "create", normalized: true },
    });
    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();
  } finally {
    await introspector.dispose();
  }
});

test("an unsigned webhook is rejected", async () => {
  const response = await webhook(JSON.stringify({ action: "create" }), Promise.resolve("wrong"));

  expect(response.status).toBe(401);
});

test("signed malformed JSON is rejected", async () => {
  const response = await webhook("{");

  expect(response.status).toBe(400);
});

test("a webhook filtered out by its trigger starts no workflow", async () => {
  const introspector = await introspectWorkflow(env.ISSUE_CREATED);
  try {
    const response = await webhook(JSON.stringify({ action: "update" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ skipped: true });
    expect(introspector.get()).toEqual([]);
  } finally {
    await introspector.dispose();
  }
});

test("a scheduled event runs its matching durable workflow", async () => {
  const introspector = await introspectWorkflow(env.DAILY);
  try {
    await worker.scheduled({ cron: "0 9 * * *", scheduledTime: 42 }, env, createExecutionContext());
    const [instance] = introspector.get();

    expect(await instance!.waitForStepResult({ name: "record-schedule" })).toEqual({
      cron: "0 9 * * *",
      scheduledTime: 42,
    });
    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();
  } finally {
    await introspector.dispose();
  }
});
