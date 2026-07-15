import {
  createExecutionContext,
  introspectWorkflow,
  introspectWorkflowInstance,
} from "cloudflare:test";
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

const signedHeaders = async (body: string, timestamp = Date.now()): Promise<HeadersInit> => ({
  "x-signature": await signatureOf(body),
  "x-timestamp": String(timestamp),
});

const webhook = async (body: string, signature = signatureOf(body)): Promise<Response> =>
  exports.default.fetch("https://runway.test/issues", {
    method: "POST",
    headers: { "x-signature": await signature, "x-timestamp": String(Date.now()) },
    body,
  });

const artifactKey = (version: string): string => `artifacts/${version}.json`;

const putArtifact = async (contents: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contents));
  const version = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await env.RUNWAY_ARTIFACTS.put(artifactKey(version), contents);
  return version;
};

const putActiveArtifact = async (): Promise<void> => {
  await env.RUNWAY_ARTIFACTS.put(artifactKey(env.ACTIVE_ARTIFACT_VERSION), env.ACTIVE_ARTIFACT);
};

const putSuspendedArtifact = async (): Promise<void> => {
  await env.RUNWAY_ARTIFACTS.put(
    artifactKey(env.SUSPENDED_ARTIFACT_VERSION),
    env.SUSPENDED_ARTIFACT,
  );
};

const createGeneratedRun = async (metadata: unknown): Promise<string> => {
  const run = await env.GENERATED_DYNAMIC.create({
    params: {
      __dispatcherMetadata: metadata,
      params: { action: "create", normalized: true },
    },
  });
  return run.id;
};

const expectGeneratedRunError = async (metadata: unknown, message: string): Promise<void> => {
  const runId = await createGeneratedRun(metadata);
  await using instance = await introspectWorkflowInstance(env.GENERATED_DYNAMIC, runId);
  await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
  await expect((await env.GENERATED_DYNAMIC.get(runId)).status()).resolves.toMatchObject({
    status: "errored",
    error: { message },
  });
};

test("a generated host reports only its no-cache deployment identity", async () => {
  const response = await env.GENERATED_HOST.fetch("https://runway.test/.runway/version");

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ deploymentId: env.ACTIVE_DEPLOYMENT_ID });
});

test("a generated host executes its active immutable artifact", async () => {
  await putActiveArtifact();
  const body = JSON.stringify({ action: "create" });
  const response = await env.GENERATED_HOST.fetch("https://runway.test/issues", {
    method: "POST",
    headers: await signedHeaders(body),
    body,
  });
  const payload = (await response.json()) as { runs: [{ id: string }] };
  await using instance = await introspectWorkflowInstance(
    env.GENERATED_DYNAMIC,
    payload.runs[0]!.id,
  );

  expect(response.status).toBe(202);
  await expect(instance.waitForStepResult({ name: "trigger-loader-state" })).resolves.toBe(0);
  await expect(instance.waitForStepResult({ name: "record-issue" })).resolves.toMatchObject({
    apiKey: "test-api-key",
  });
  await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
});

test("a generated host evaluates authored webhook gates inside the artifact", async () => {
  await putActiveArtifact();
  const body = JSON.stringify({ action: "update" });
  const filtered = await env.GENERATED_HOST.fetch("https://runway.test/issues", {
    method: "POST",
    headers: await signedHeaders(body),
    body,
  });
  const unsigned = await env.GENERATED_HOST.fetch("https://runway.test/issues", {
    method: "POST",
    headers: { "x-timestamp": String(Date.now()) },
    body,
  });
  const stale = await env.GENERATED_HOST.fetch("https://runway.test/issues", {
    method: "POST",
    headers: await signedHeaders(body, Date.now() - 120_000),
    body,
  });

  expect(filtered.status).toBe(200);
  await expect(filtered.json()).resolves.toEqual({ skipped: true });
  expect(unsigned.status).toBe(401);
  expect(stale.status).toBe(401);
});

test("a generated start persists only its artifact version beside the event", async () => {
  await env.GENERATED_WORKFLOW_CAPTURE.reset();
  await putActiveArtifact();
  const body = JSON.stringify({ action: "create" });

  const response = await env.GENERATED_CAPTURE_HOST.fetch("https://runway.test/issues", {
    method: "POST",
    headers: await signedHeaders(body),
    body,
  });

  expect(response.status).toBe(202);
  await expect(env.GENERATED_WORKFLOW_CAPTURE.captured()).resolves.toEqual({
    __dispatcherMetadata: { artifactVersion: env.ACTIVE_ARTIFACT_VERSION },
    params: { action: "create", normalized: true },
  });
});

test("a Dynamic Workflow loads the artifact version and secrets selected by its metadata", async () => {
  await putSuspendedArtifact();
  const runId = await createGeneratedRun({
    artifactVersion: env.SUSPENDED_ARTIFACT_VERSION,
  });
  await using instance = await introspectWorkflowInstance(env.GENERATED_DYNAMIC, runId);

  await expect(instance.waitForStepResult({ name: "artifact-version" })).resolves.toBe("suspended");
  await expect(instance.waitForStepResult({ name: "historical-secret" })).resolves.toBe(
    "runner-secret",
  );
  await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
});

test("a Dynamic Workflow fails closed when its exact artifact is unavailable", async () => {
  await expectGeneratedRunError({ artifactVersion: "1".repeat(64) }, "missing workflow artifact");
});

test("a Dynamic Workflow rejects tampered artifact bytes", async () => {
  const artifactVersion = "2".repeat(64);
  await env.RUNWAY_ARTIFACTS.put(artifactKey(artifactVersion), "tampered artifact");

  await expectGeneratedRunError({ artifactVersion }, "invalid workflow artifact hash");
});

test("a Dynamic Workflow rejects a content-addressed artifact with an invalid shape", async () => {
  const artifactVersion = await putArtifact(JSON.stringify({ source: "export default {}" }));

  await expectGeneratedRunError({ artifactVersion }, "invalid workflow artifact");
});

test("a Dynamic Workflow rejects an artifact owned by another script", async () => {
  const active = JSON.parse(env.ACTIVE_ARTIFACT) as Record<string, unknown>;
  const artifactVersion = await putArtifact(
    JSON.stringify({ ...active, scriptName: "another-runway-host" }),
  );

  await expectGeneratedRunError({ artifactVersion }, "workflow artifact does not match route");
});

test("a Dynamic Workflow rejects metadata beyond the current artifact contract", async () => {
  await expectGeneratedRunError(
    {
      artifactVersion: env.ACTIVE_ARTIFACT_VERSION,
      unexpected: true,
    },
    "invalid workflow metadata",
  );
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
      envKeys: [],
      event: { action: "create", normalized: true },
    });
    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();
  } finally {
    await introspector.dispose();
  }
});

test("a generated host capability returns only declared secrets", async () => {
  await expect(env.GENERATED_ISSUE_HOST.secrets()).resolves.toEqual({
    API_KEY: "test-api-key",
    HOOK_SECRET: "test-secret",
  });
});

test("a generated host resolves the immutable snapshot key named by its root", async () => {
  const snapshot = await env.GENERATED_ISSUE_HOST.captureSecrets("run-id");
  const probe = exports.CapabilityProbe({ props: {} });
  const envelope = JSON.parse(snapshot) as { key: string; value: string };
  const tampered = JSON.stringify({
    ...envelope,
    value: `${envelope.value.startsWith("A") ? "B" : "A"}${envelope.value.slice(1)}`,
  });

  expect(snapshot).not.toContain("test-api-key");
  expect(snapshot).not.toContain("test-secret");
  expect(envelope.key).toBe("RUNWAY_SECRET_SNAPSHOT_KEY_TEST");
  await expect(env.GENERATED_ISSUE_HOST.restoreSecrets("run-id", snapshot)).resolves.toEqual({
    API_KEY: "test-api-key",
    HOOK_SECRET: "test-secret",
  });
  await expect(probe.invoke("restoreSecrets", ["another-run", snapshot])).resolves.toBe(
    "invalid secret snapshot",
  );
  await expect(probe.invoke("restoreSecrets", ["run-id", tampered])).resolves.toBe(
    "invalid secret snapshot",
  );
});

test("an unsigned webhook is rejected", async () => {
  expect(
    (await webhook(JSON.stringify({ action: "create" }), Promise.resolve("wrong"))).status,
  ).toBe(401);
});

test("signed malformed JSON is rejected", async () => {
  expect((await webhook("{")).status).toBe(400);
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
