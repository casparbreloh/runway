import {
  createExecutionContext,
  introspectWorkflow,
  introspectWorkflowInstance,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";

import { repositoryFixture } from "./repository-fixture.ts";
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

const githubSignatureOf = async (body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("github-webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

const baseRepository = { id: 101, name: "runway", full_name: "casparbreloh/runway" };

const pushPayload = (sha: string, ref = "refs/heads/main") => ({
  ref,
  after: sha,
  deleted: false,
  installation: { id: 42 },
  repository: baseRepository,
});

const pullRequestPayload = (
  sha: string,
  options: { number?: number; headRepository?: typeof baseRepository } = {},
) => ({
  action: "synchronize",
  number: options.number ?? 17,
  installation: { id: 42 },
  repository: baseRepository,
  pull_request: {
    base: { repo: baseRepository },
    head: {
      ref: "feature/github-ci",
      sha,
      repo: options.headRepository ?? baseRepository,
    },
  },
});

const deliverGitHub = async (options: {
  deliveryId: string;
  event: "push" | "pull_request";
  payload: unknown;
}): Promise<Response> => {
  const body = JSON.stringify(options.payload);
  return await env.GITHUB_HOST.fetch("https://runway.test/.runway/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": options.deliveryId,
      "x-github-event": options.event,
      "x-hub-signature-256": await githubSignatureOf(body),
    },
    body,
  });
};

const deliverManyGitHub = async (deliveryId: string): Promise<Response> => {
  const payload = {
    ref: "refs/heads/main",
    after: "e".repeat(40),
    deleted: false,
    installation: { id: 43 },
    repository: {
      id: 102,
      name: "runway-many",
      full_name: "casparbreloh/runway-many",
    },
  };
  const body = JSON.stringify(payload);
  return await env.GITHUB_MANY_HOST.fetch("https://runway.test/.runway/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "push",
      "x-hub-signature-256": await githubSignatureOf(body),
    },
    body,
  });
};

const eventually = async (assertion: () => Promise<void>): Promise<void> => {
  let error: unknown;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (caught) {
      error = caught;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw error;
};

interface GitHubWorkflowProbeState {
  runs: Array<[string, unknown]>;
  creates: Array<{ id: string; params: unknown }>;
  terminations: string[];
  terminationAttempts: string[];
}

const githubWorkflowProbeState = async (): Promise<GitHubWorkflowProbeState> =>
  await (
    env.RUNWAY_GITHUB_WORKFLOW as unknown as {
      state(): Promise<GitHubWorkflowProbeState>;
    }
  ).state();

const waitForGitHubCreates = async (runIds: ReadonlyArray<string>): Promise<void> =>
  await eventually(async () => {
    const created = new Set((await githubWorkflowProbeState()).creates.map(({ id }) => id));
    expect(runIds.every((runId) => created.has(runId))).toBe(true);
  });

const testSandbox = exports.TestSandbox({ props: {} });
const testHost = exports.TestHost({
  props: {
    secrets: {
      API_KEY: "test-api-key",
      HOOK_SECRET: "test-secret",
      SANDBOX_SECRET: "sandbox-secret",
    },
  },
});

beforeEach(async () => {
  await env.RUNWAY_GITHUB_PROVIDER.reset();
  await env.RUNWAY_GITHUB_WORKFLOW.reset();
  await env.RUNWAY_GITHUB_CLOCK.reset();
  await testSandbox.reset();
  await testHost.resetSecret();
});

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

test.each([
  {
    name: "successful handler",
    params: { commands: ["true"] },
    status: "complete" as const,
    events: [
      "lifecycle:in_progress",
      "handler:start",
      "handler:success",
      "cleanup:start",
      "cleanup:success",
      "lifecycle:success",
    ],
  },
  {
    name: "thrown handler",
    params: { commands: ["true"], throwAfterCommands: true },
    status: "errored" as const,
    events: [
      "lifecycle:in_progress",
      "handler:start",
      "cleanup:start",
      "cleanup:success",
      "lifecycle:failure",
    ],
  },
  {
    name: "nonzero exec",
    params: { commands: ["exit 7"] },
    status: "errored" as const,
    events: [
      "lifecycle:in_progress",
      "handler:start",
      "cleanup:start",
      "cleanup:success",
      "lifecycle:failure",
    ],
  },
  {
    name: "undefined thrown value",
    params: { commands: ["true"], throwUndefinedAfterCommands: true },
    status: "errored" as const,
    events: [
      "lifecycle:in_progress",
      "handler:start",
      "cleanup:start",
      "cleanup:success",
      "lifecycle:failure",
    ],
  },
])("runtime lifecycle orders $name after cleanup", async ({ params, status, events }) => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    await env.COMMANDS.create({ params });
    const [instance] = introspector.get();
    await expect(instance!.waitForStatus(status)).resolves.not.toThrow();
    await expect(testHost.lifecycleEvents()).resolves.toEqual(events);
  } finally {
    await introspector.dispose();
  }
});

test("the runtime durably records success after cleanup and before publication", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    const run = await env.COMMANDS.create({ params: { commands: ["true"] } });
    const [instance] = introspector.get();

    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();
    await expect(
      instance!.waitForStepResult({ name: "runway:terminal-claim" }),
    ).resolves.toMatchObject({
      claimId: expect.any(String),
      outcome: "success",
      runId: run.id,
    });
    await expect(testHost.lifecycleEvents()).resolves.toEqual([
      "lifecycle:in_progress",
      "handler:start",
      "handler:success",
      "cleanup:start",
      "cleanup:success",
      "lifecycle:success",
    ]);
  } finally {
    await introspector.dispose();
  }
});

test("cleanup failure durably wins failure before any terminal publication", async () => {
  await testSandbox.failDestroyOnce();
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    await env.COMMANDS.create({ params: { commands: ["true"] } });
    const [instance] = introspector.get();
    await expect(instance!.waitForStatus("errored")).resolves.not.toThrow();
    await expect(
      instance!.waitForStepResult({ name: "runway:terminal-claim" }),
    ).resolves.toMatchObject({ outcome: "failure" });
    await expect(testHost.lifecycleEvents()).resolves.toEqual([
      "lifecycle:in_progress",
      "handler:start",
      "handler:success",
      "cleanup:start",
      "cleanup:failure",
      "lifecycle:failure",
      "cleanup:start",
      "cleanup:success",
    ]);
  } finally {
    await introspector.dispose();
  }
});

test.each([
  ["capture", "setup capture failure", async () => await testHost.failSecretCapturePermanently()],
  ["restore", "setup restore failure", async () => await testHost.failSecretRestoreOnce()],
  [
    "validation",
    "missing secret: SANDBOX_SECRET",
    async () => await testHost.failSecretValidationOnce(),
  ],
])(
  "secret %s failure reports failure without entering the handler or cleanup",
  async (_stage, message, fail) => {
    await fail();
    const introspector = await introspectWorkflow(env.COMMANDS);
    try {
      const run = await env.COMMANDS.create({ params: { commands: ["true"] } });
      const [instance] = introspector.get();
      await expect(instance!.waitForStatus("errored")).resolves.not.toThrow();
      await expect(testHost.lifecycleEvents()).resolves.toEqual([
        "lifecycle:in_progress",
        "lifecycle:failure",
      ]);
      await expect((await env.COMMANDS.get(run.id)).status()).resolves.toMatchObject({
        status: "errored",
        error: { message },
      });
      await expect(testSandbox.state()).resolves.toMatchObject({ executions: [], destroys: [] });
    } finally {
      await introspector.dispose();
    }
  },
  60_000,
);

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

const putGitHubArtifacts = async (): Promise<void> => {
  await Promise.all([
    env.RUNWAY_ARTIFACTS.put(
      artifactKey(env.GITHUB_CHECK_ARTIFACT_VERSION),
      env.GITHUB_CHECK_ARTIFACT,
    ),
    env.RUNWAY_ARTIFACTS.put(
      artifactKey(env.GITHUB_TEST_ARTIFACT_VERSION),
      env.GITHUB_TEST_ARTIFACT,
    ),
  ]);
};

const startGitHubWorkflow = async (create: {
  id: string;
  params: unknown;
}): Promise<ReturnType<typeof introspectWorkflowInstance>> => {
  await env.GITHUB_DYNAMIC.create({ id: create.id, params: create.params });
  return await introspectWorkflowInstance(env.GITHUB_DYNAMIC, create.id);
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

const createRepositoryProbeRun = async (metadata: unknown): Promise<string> => {
  const run = await env.REPOSITORY_PROBE_DYNAMIC.create({
    params: {
      __dispatcherMetadata: metadata,
      params: { action: "create", normalized: true },
    },
  });
  return run.id;
};

const githubRunSource = () => ({
  type: "github" as const,
  installationId: 42,
  repository: { id: 101, name: "runway", fullName: "casparbreloh/runway" },
  commit: "2328fb0d0e8629a84abc11d820715cb5c78b629c",
  deliveryId: "123e4567-e89b-42d3-a456-426614174000",
  runId: "run-github",
  generation: 1,
  check: {
    id: 501,
    name: "Check",
    repository: { id: 101, name: "runway", fullName: "casparbreloh/runway" },
  },
});

const expectGeneratedRunError = async (metadata: unknown, message: string): Promise<void> => {
  const runId = await createGeneratedRun(metadata);
  await using instance = await introspectWorkflowInstance(env.GENERATED_DYNAMIC, runId);
  await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
  await expect((await env.GENERATED_DYNAMIC.get(runId)).status()).resolves.toMatchObject({
    status: "errored",
    error: { message },
  });
};

test("GitHub ingress durably admits every matching workflow and responds before provider work", async () => {
  await env.RUNWAY_GITHUB_PROVIDER.configure({ tokenDelayMs: 250 });
  const started = Date.now();
  const response = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174101",
    event: "push",
    payload: pushPayload("1".repeat(40)),
  });
  const payload = (await response.json()) as { runs: Array<{ id: string; workflow: string }> };

  expect(response.status).toBe(202);
  expect(Date.now() - started).toBeLessThan(200);
  expect(payload.runs.map(({ workflow }) => workflow).sort()).toEqual([
    "github-check",
    "github-test",
  ]);
  expect(new Set(payload.runs.map(({ id }) => id)).size).toBe(2);
  await waitForGitHubCreates(payload.runs.map(({ id }) => id));
});

test("bounded alarm batches drain more than one batch without missing or crossing runs", async () => {
  const startedAt = Date.now();
  const response = await deliverManyGitHub("123e4567-e89b-42d3-a456-426614174114");
  const elapsed = Date.now() - startedAt;
  const payload = (await response.json()) as { runs: Array<{ id: string; workflow: string }> };

  expect(response.status).toBe(202);
  expect(elapsed).toBeLessThan(1_000);
  expect(payload.runs).toHaveLength(40);
  expect(new Set(payload.runs.map(({ id }) => id))).toHaveProperty("size", 40);
  await eventually(async () => {
    const provider = await env.RUNWAY_GITHUB_PROVIDER.state();
    const workflows = await githubWorkflowProbeState();
    expect(provider.checks).toHaveLength(40);
    expect(workflows.creates).toHaveLength(40);
    expect(new Set(workflows.creates.map(({ id }) => id))).toHaveProperty("size", 40);
    expect(workflows.creates.map(({ id }) => id).sort()).toEqual(
      payload.runs.map(({ id }) => id).sort(),
    );
  });
});

test("corrupted durable identities and contradictory flags fail closed before provider effects", async () => {
  const now = await env.RUNWAY_GITHUB_CLOCK.now();
  const deliveryId = "123e4567-e89b-42d3-a456-426614174115";
  const workflowId = "github-check";
  const activeKey = `${workflowId}:push:101:refs/heads/main`;
  const delivery = {
    status: "accepted",
    deliveryId,
    installationId: 42,
    checkRepository: { id: 101, name: "runway", fullName: "casparbreloh/runway" },
    checkoutRepository: { id: 101, name: "runway", fullName: "casparbreloh/runway" },
    event: {
      type: "push",
      repository: { id: 101, name: "runway", fullName: "casparbreloh/runway" },
      ref: "refs/heads/main",
      sha: "f".repeat(40),
    },
    concurrency: { type: "push", repositoryId: 101, ref: "refs/heads/main" },
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`101\0${deliveryId}\0${workflowId}`),
  );
  const seed = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 48);
  const namespace = env.GITHUB_COORDINATOR_TEST as unknown as {
    getByName(name: string): {
      seedForTest(entries: Record<string, unknown>): Promise<void>;
      alarmResultForTest(): Promise<{ ok: boolean; error?: string }>;
    };
  };
  const seedRun = async (
    objectName: string,
    runId: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const stub = namespace.getByName(objectName);
    await stub.seedForTest({
      [`generation:${activeKey}`]: 1,
      [`active:${activeKey}`]: { kind: "active", activeKey, runId, generation: 1 },
      [`run:${runId}`]: {
        kind: "run",
        runId,
        workflowId,
        artifactVersion: "a".repeat(64),
        checkName: "Check",
        delivery,
        activeKey,
        generation: 1,
        expiresAt: now + 7 * 24 * 60 * 60 * 1_000,
        desired: "queued",
        preflightComplete: false,
        checkCreateAttempted: false,
        checkRunId: null,
        workflowCreateAttempted: false,
        workflowKnown: false,
        checkInProgressComplete: false,
        checkCompletionComplete: false,
        terminationComplete: false,
        checkCancellationComplete: false,
        retryCount: 0,
        nextAttemptAt: now,
        ...overrides,
      },
      [`pending:${String(now).padStart(16, "0")}:${runId}`]: {
        kind: "pending",
        runId,
        dueAt: now,
      },
    });
    return stub;
  };

  const forged = await seedRun("forged-run", `runway-github-${"f".repeat(48)}-1`);
  await expect(forged.alarmResultForTest()).resolves.toEqual({
    ok: false,
    error: "invalid GitHub coordinator state",
  });

  const contradictory = await seedRun("contradictory-run", `runway-github-${seed}-1`, {
    checkCreateAttempted: true,
    checkRunId: 77,
    workflowKnown: true,
  });
  await expect(contradictory.alarmResultForTest()).resolves.toEqual({
    ok: false,
    error: "invalid GitHub coordinator state",
  });
  const skippedProgress = await seedRun("skipped-progress", `runway-github-${seed}-1`, {
    desired: "success",
    preflightComplete: true,
    checkCreateAttempted: true,
    checkRunId: 77,
    workflowCreateAttempted: true,
    workflowKnown: true,
    checkCompletionComplete: true,
  });
  await expect(skippedProgress.alarmResultForTest()).resolves.toEqual({
    ok: false,
    error: "invalid GitHub coordinator state",
  });
  expect((await env.RUNWAY_GITHUB_PROVIDER.state()).tokenStarts).toHaveLength(0);
});

test("the fixed GitHub ingress fails closed before durable admission", async () => {
  const body = JSON.stringify(pushPayload("f".repeat(40)));
  const get = await env.GITHUB_HOST.fetch("https://runway.test/.runway/github");
  const unsigned = await env.GITHUB_HOST.fetch("https://runway.test/.runway/github", {
    method: "POST",
    headers: {
      "x-github-delivery": "123e4567-e89b-42d3-a456-426614174114",
      "x-github-event": "push",
    },
    body,
  });

  expect(get.status).toBe(404);
  expect(unsigned.status).toBe(401);
  expect((await env.RUNWAY_GITHUB_PROVIDER.state()).tokens).toEqual([]);
  expect((await githubWorkflowProbeState()).creates).toEqual([]);
});

test("a signed delivery for another installation is skipped before durable admission", async () => {
  const response = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174118",
    event: "push",
    payload: { ...pushPayload("3".repeat(40)), installation: { id: 99 } },
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ skipped: true });
  expect((await env.RUNWAY_GITHUB_PROVIDER.state()).tokens).toEqual([]);
  expect((await githubWorkflowProbeState()).creates).toEqual([]);
});

test("a duplicate GitHub delivery resumes the same per-workflow dispatch without duplicate effects", async () => {
  const request = {
    deliveryId: "123e4567-e89b-42d3-a456-426614174102",
    event: "pull_request" as const,
    payload: pullRequestPayload("2".repeat(40)),
  };
  const first = await deliverGitHub(request);
  const firstPayload = (await first.json()) as { runs: Array<{ id: string }> };
  await waitForGitHubCreates(firstPayload.runs.map(({ id }) => id));

  const duplicate = await deliverGitHub(request);
  const duplicatePayload = (await duplicate.json()) as { runs: Array<{ id: string }> };
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(duplicate.status).toBe(202);
  expect(duplicatePayload.runs).toEqual(firstPayload.runs);
  expect((await env.RUNWAY_GITHUB_PROVIDER.state()).checks).toHaveLength(2);
  expect((await githubWorkflowProbeState()).creates).toHaveLength(2);
});

test("lost Check and Workflow create responses reconcile their exact persisted intents", async () => {
  await env.RUNWAY_GITHUB_PROVIDER.configure({ loseCheckCreateResponse: true });
  await env.RUNWAY_GITHUB_WORKFLOW.configure({ loseCreateResponse: true });
  const fork = { id: 204, name: "runway-fork", full_name: "contributor/runway-fork" };

  const response = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174103",
    event: "pull_request",
    payload: pullRequestPayload("3".repeat(40), { number: 19, headRepository: fork }),
  });
  const payload = (await response.json()) as { runs: Array<{ id: string }> };

  await eventually(async () => {
    const provider = await env.RUNWAY_GITHUB_PROVIDER.state();
    const workflows = await githubWorkflowProbeState();
    expect(provider.checks).toHaveLength(2);
    expect(workflows.creates).toHaveLength(2);
    expect(provider.checks.map(({ externalId }) => externalId).sort()).toEqual(
      payload.runs.map(({ id }) => id).sort(),
    );
    expect(provider.reconciliations).toHaveLength(1);
    expect(provider.checks).toContainEqual(
      expect.objectContaining({
        name: provider.reconciliations[0]!.name,
        headSha: provider.reconciliations[0]!.headSha,
        externalId: provider.reconciliations[0]!.runId,
      }),
    );
    for (const create of workflows.creates) {
      const params = create.params as {
        __dispatcherMetadata: {
          artifactVersion: string;
          source: ReturnType<typeof githubRunSource>;
        };
        params: { sha: string; type: string };
      };
      const check = provider.checks.find(({ externalId }) => externalId === create.id)!;
      expect(params.__dispatcherMetadata).toMatchObject({
        artifactVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
        source: {
          type: "github",
          installationId: 42,
          repository: { id: fork.id, name: fork.name, fullName: fork.full_name },
          commit: "3".repeat(40),
          deliveryId: "123e4567-e89b-42d3-a456-426614174103",
          runId: create.id,
          generation: 1,
          check: {
            id: check.id,
            name: check.name,
            repository: { id: 101, name: "runway", fullName: "casparbreloh/runway" },
          },
        },
      });
      expect(params.params).toMatchObject({ type: "pull_request", sha: "3".repeat(40) });
    }
  });
});

test("workflow runtime owns in-progress and terminal Check transitions after cleanup", async () => {
  await putGitHubArtifacts();
  const response = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174130",
    event: "push",
    payload: pushPayload("3".repeat(40), "refs/heads/develop"),
  });
  const runs = (await response.json()) as {
    runs: Array<{ id: string; workflow: string }>;
  };
  await waitForGitHubCreates(runs.runs.map(({ id }) => id));
  const creates = (await githubWorkflowProbeState()).creates;
  const successRef = runs.runs.find(({ workflow }) => workflow === "github-check")!;
  const failureRef = runs.runs.find(({ workflow }) => workflow === "github-test")!;
  await using success = await startGitHubWorkflow(creates.find(({ id }) => id === successRef.id)!);
  await using failure = await startGitHubWorkflow(creates.find(({ id }) => id === failureRef.id)!);

  await expect(success.waitForStatus("complete")).resolves.not.toThrow();
  await expect(failure.waitForStatus("errored")).resolves.not.toThrow();
  await eventually(async () => {
    const provider = await env.RUNWAY_GITHUB_PROVIDER.state();
    const successCheck = provider.checks.find(({ externalId }) => externalId === successRef.id)!;
    const failureCheck = provider.checks.find(({ externalId }) => externalId === failureRef.id)!;
    expect(successCheck).toMatchObject({ status: "completed", conclusion: "success" });
    expect(failureCheck).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(provider.updates.filter(({ checkRunId }) => checkRunId === successCheck.id)).toEqual([
      { checkRunId: successCheck.id, state: "in_progress" },
      { checkRunId: successCheck.id, state: "success" },
    ]);
    expect(provider.updates.filter(({ checkRunId }) => checkRunId === failureCheck.id)).toEqual([
      { checkRunId: failureCheck.id, state: "in_progress" },
      { checkRunId: failureCheck.id, state: "failure" },
    ]);
  });
});

test("lost Check PATCH responses retry the persisted transition without re-running handlers", async () => {
  await putGitHubArtifacts();
  const response = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174131",
    event: "push",
    payload: pushPayload("4".repeat(40), "refs/heads/develop"),
  });
  const runs = (await response.json()) as {
    runs: Array<{ id: string; workflow: string }>;
  };
  await waitForGitHubCreates(runs.runs.map(({ id }) => id));
  await env.RUNWAY_GITHUB_PROVIDER.configure({ losePatchResponse: true });
  const ref = runs.runs.find(({ workflow }) => workflow === "github-check")!;
  const create = (await githubWorkflowProbeState()).creates.find(({ id }) => id === ref.id)!;
  await using instance = await startGitHubWorkflow(create);
  await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
  await env.RUNWAY_GITHUB_CLOCK.advance(1_000);
  await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174131",
    event: "push",
    payload: pushPayload("4".repeat(40), "refs/heads/develop"),
  });

  await eventually(async () => {
    const provider = await env.RUNWAY_GITHUB_PROVIDER.state();
    const check = provider.checks.find(({ externalId }) => externalId === ref.id)!;
    expect(check).toMatchObject({ status: "completed", conclusion: "success" });
    expect(
      provider.updates.filter(
        ({ checkRunId, state }) => checkRunId === check.id && state === "in_progress",
      ),
    ).toHaveLength(2);
  });
});

test("supersession before runtime start fences the old handler and keeps cancelled final", async () => {
  await putGitHubArtifacts();
  const oldResponse = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174132",
    event: "pull_request",
    payload: pullRequestPayload("5".repeat(40), { number: 41 }),
  });
  const oldRuns = (await oldResponse.json()) as {
    runs: Array<{ id: string; workflow: string }>;
  };
  await waitForGitHubCreates(oldRuns.runs.map(({ id }) => id));
  const oldFailure = oldRuns.runs.find(({ workflow }) => workflow === "github-test")!;
  const oldCreate = (await githubWorkflowProbeState()).creates.find(
    ({ id }) => id === oldFailure.id,
  )!;
  const latestResponse = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174133",
    event: "pull_request",
    payload: pullRequestPayload("6".repeat(40), { number: 41 }),
  });
  const latestRuns = (await latestResponse.json()) as { runs: Array<{ id: string }> };
  await waitForGitHubCreates(latestRuns.runs.map(({ id }) => id));
  await eventually(async () => {
    const oldChecks = (await env.RUNWAY_GITHUB_PROVIDER.state()).checks.filter(({ externalId }) =>
      oldRuns.runs.some(({ id }) => id === externalId),
    );
    expect(oldChecks.map(({ conclusion }) => conclusion)).toEqual(["cancelled", "cancelled"]);
  });

  await using instance = await startGitHubWorkflow(oldCreate);
  await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
  const provider = await env.RUNWAY_GITHUB_PROVIDER.state();
  const check = provider.checks.find(({ externalId }) => externalId === oldFailure.id)!;
  expect(check.conclusion).toBe("cancelled");
  expect(provider.updates.filter(({ checkRunId }) => checkRunId === check.id)).toEqual([
    { checkRunId: check.id, state: "cancelled" },
  ]);
});

test("cancellation beats a persisted success while its Check effect is awaiting", async () => {
  await putGitHubArtifacts();
  const oldResponse = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174134",
    event: "pull_request",
    payload: pullRequestPayload("7".repeat(40), { number: 42 }),
  });
  const oldRuns = (await oldResponse.json()) as {
    runs: Array<{ id: string; workflow: string }>;
  };
  await waitForGitHubCreates(oldRuns.runs.map(({ id }) => id));
  await env.RUNWAY_GITHUB_PROVIDER.configure({ checkTokenDelayMs: 250 });
  const oldSuccess = oldRuns.runs.find(({ workflow }) => workflow === "github-check")!;
  const oldCreate = (await githubWorkflowProbeState()).creates.find(
    ({ id }) => id === oldSuccess.id,
  )!;
  await using instance = await startGitHubWorkflow(oldCreate);
  await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
  const latestResponse = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174135",
    event: "pull_request",
    payload: pullRequestPayload("8".repeat(40), { number: 42 }),
  });
  const latestRuns = (await latestResponse.json()) as { runs: Array<{ id: string }> };
  await env.RUNWAY_GITHUB_PROVIDER.configure({ checkTokenDelayMs: 0 });
  await waitForGitHubCreates(latestRuns.runs.map(({ id }) => id));

  await eventually(async () => {
    const provider = await env.RUNWAY_GITHUB_PROVIDER.state();
    const check = provider.checks.find(({ externalId }) => externalId === oldSuccess.id)!;
    expect(check).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect(provider.updates.filter(({ checkRunId }) => checkRunId === check.id)).not.toContainEqual(
      {
        checkRunId: check.id,
        state: "success",
      },
    );
    expect(
      provider.checks
        .filter(({ externalId }) => oldRuns.runs.some(({ id }) => id === externalId))
        .map(({ conclusion }) => conclusion),
    ).toEqual(["cancelled", "cancelled"]);
  });
});

test("terminate failure retries before the cancelled Check transition", async () => {
  const oldResponse = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174136",
    event: "pull_request",
    payload: pullRequestPayload("9".repeat(40), { number: 43 }),
  });
  const oldRuns = (await oldResponse.json()) as {
    runs: Array<{ id: string; workflow: string }>;
  };
  await waitForGitHubCreates(oldRuns.runs.map(({ id }) => id));
  await env.RUNWAY_GITHUB_WORKFLOW.configure({ failTerminateAttempts: 1 });
  const latest = {
    deliveryId: "123e4567-e89b-42d3-a456-426614174137",
    event: "pull_request" as const,
    payload: pullRequestPayload("a".repeat(40), { number: 43 }),
  };
  const latestResponse = await deliverGitHub(latest);
  const latestRuns = (await latestResponse.json()) as { runs: Array<{ id: string }> };
  await eventually(async () => {
    expect(
      (await env.RUNWAY_GITHUB_PROVIDER.state()).effectEvents.some((event) =>
        event.endsWith(":failure"),
      ),
    ).toBe(true);
  });
  const failedId = (await env.RUNWAY_GITHUB_PROVIDER.state()).effectEvents
    .find((event) => event.endsWith(":failure"))!
    .slice("terminate:".length, -":failure".length);
  const failedCheck = (await env.RUNWAY_GITHUB_PROVIDER.state()).checks.find(
    ({ externalId }) => externalId === failedId,
  )!;

  await env.RUNWAY_GITHUB_CLOCK.advance(1_000);
  await deliverGitHub(latest);
  await eventually(async () => {
    const workflows = await githubWorkflowProbeState();
    const provider = await env.RUNWAY_GITHUB_PROVIDER.state();
    expect(workflows.terminations.slice().sort()).toEqual(oldRuns.runs.map(({ id }) => id).sort());
    expect(
      provider.checks
        .filter(({ externalId }) => oldRuns.runs.some(({ id }) => id === externalId))
        .map(({ conclusion }) => conclusion),
    ).toEqual(["cancelled", "cancelled"]);
    const failed = provider.effectEvents.indexOf(`terminate:${failedId}:failure`);
    const terminated = provider.effectEvents.indexOf(`terminate:${failedId}:success`);
    const cancelled = provider.effectEvents.indexOf(`check:${failedCheck.id}:cancelled`);
    expect(failed).toBeGreaterThanOrEqual(0);
    expect(terminated).toBeGreaterThan(failed);
    expect(cancelled).toBeGreaterThan(terminated);
  });
  await waitForGitHubCreates(latestRuns.runs.map(({ id }) => id));
});

test("WorkflowInstance and terminal status response properties do not strand recovered effects", async () => {
  await env.RUNWAY_GITHUB_WORKFLOW.configure({
    loseCreateResponse: true,
    instanceCreateResponse: true,
    statusResponse: {
      status: "errored",
      error: { name: "UserWorkflowError", message: "already finished" },
      output: { completed: true },
      platformTrace: "trace-123",
    },
  });
  const first = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174125",
    event: "pull_request",
    payload: pullRequestPayload("a".repeat(40), { number: 20 }),
  });
  const firstRuns = ((await first.json()) as { runs: Array<{ id: string }> }).runs;
  await eventually(async () => {
    expect((await env.RUNWAY_GITHUB_PROVIDER.state()).checks).toHaveLength(2);
    expect((await githubWorkflowProbeState()).creates).toHaveLength(2);
  });

  await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174126",
    event: "pull_request",
    payload: pullRequestPayload("b".repeat(40), { number: 20 }),
  });
  await eventually(async () => {
    const provider = await env.RUNWAY_GITHUB_PROVIDER.state();
    const workflows = await githubWorkflowProbeState();
    expect(workflows.creates).toHaveLength(4);
    expect(workflows.terminations).toEqual([]);
    expect(
      provider.completions
        .filter(({ conclusion }) => conclusion === "cancelled")
        .map(({ checkRunId }) => checkRunId),
    ).toHaveLength(2);
    expect(
      provider.checks
        .filter(({ externalId }) => firstRuns.some(({ id }) => id === externalId))
        .map(({ conclusion }) => conclusion),
    ).toEqual(["cancelled", "cancelled"]);
  });
});

test("transient provider outages use persisted capped backoff and resume only when due", async () => {
  const fork = { id: 209, name: "runway-fork", full_name: "backoff/runway-fork" };
  await env.RUNWAY_GITHUB_PROVIDER.configure({
    failTokenAttempts: 4,
    failTokenRepositoryId: fork.id,
  });
  const request = {
    deliveryId: "123e4567-e89b-42d3-a456-426614174124",
    event: "pull_request" as const,
    payload: pullRequestPayload("d".repeat(40), { number: 44, headRepository: fork }),
  };
  const starts = async (): Promise<number> =>
    (await env.RUNWAY_GITHUB_PROVIDER.state()).tokenStarts.filter(
      ({ repositoryId }) => repositoryId === fork.id,
    ).length;

  expect((await deliverGitHub(request)).status).toBe(202);
  await eventually(async () => {
    expect(await starts()).toBe(2);
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await starts()).toBe(2);

  await env.RUNWAY_GITHUB_CLOCK.advance(1_000);
  expect((await deliverGitHub(request)).status).toBe(202);
  await eventually(async () => {
    expect(await starts()).toBe(4);
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await starts()).toBe(4);

  await env.RUNWAY_GITHUB_CLOCK.advance(2_000);
  expect((await deliverGitHub(request)).status).toBe(202);
  await eventually(async () => {
    const creates = (await githubWorkflowProbeState()).creates.filter(({ params }) => {
      const source = (
        params as { __dispatcherMetadata?: { source?: { repository?: { id?: number } } } }
      ).__dispatcherMetadata?.source;
      return source?.repository?.id === fork.id;
    });
    expect(creates).toHaveLength(2);
  });
});

test("a newer generation cancels only the same workflow and exact repository PR/ref key", async () => {
  const first = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174104",
    event: "pull_request",
    payload: pullRequestPayload("4".repeat(40), { number: 27 }),
  });
  const firstRuns = ((await first.json()) as { runs: Array<{ id: string }> }).runs;
  await eventually(async () => {
    expect((await githubWorkflowProbeState()).creates).toHaveLength(2);
  });

  await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174105",
    event: "pull_request",
    payload: pullRequestPayload("5".repeat(40), { number: 28 }),
  });
  await eventually(async () => {
    expect((await githubWorkflowProbeState()).creates).toHaveLength(4);
  });
  expect((await githubWorkflowProbeState()).terminations).toEqual([]);

  await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174106",
    event: "pull_request",
    payload: pullRequestPayload("6".repeat(40), { number: 27 }),
  });
  await eventually(async () => {
    const state = await githubWorkflowProbeState();
    expect(state.creates).toHaveLength(6);
    expect(state.terminations.slice().sort()).toEqual(firstRuns.map(({ id }) => id).sort());
    const provider = await env.RUNWAY_GITHUB_PROVIDER.state();
    const priorCheckIds = provider.checks
      .filter(({ externalId }) => firstRuns.some(({ id }) => id === externalId))
      .map(({ id }) => id)
      .sort((left, right) => left - right);
    expect(
      provider.completions.slice().sort((left, right) => left.checkRunId - right.checkRunId),
    ).toEqual(priorCheckIds.map((checkRunId) => ({ checkRunId, conclusion: "cancelled" })));
  });
});

test("push supersession uses the full branch ref and leaves other refs active", async () => {
  const first = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174109",
    event: "push",
    payload: pushPayload("9".repeat(40), "refs/heads/release-a"),
  });
  const firstRuns = ((await first.json()) as { runs: Array<{ id: string }> }).runs;
  await eventually(async () => {
    expect((await githubWorkflowProbeState()).creates).toHaveLength(2);
  });
  await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174110",
    event: "push",
    payload: pushPayload("a".repeat(40), "refs/heads/release-b"),
  });
  await eventually(async () => {
    expect((await githubWorkflowProbeState()).creates).toHaveLength(4);
  });
  expect((await githubWorkflowProbeState()).terminations).toEqual([]);

  await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174111",
    event: "push",
    payload: pushPayload("b".repeat(40), "refs/heads/release-a"),
  });
  await eventually(async () => {
    const workflows = await githubWorkflowProbeState();
    expect(workflows.creates).toHaveLength(6);
    expect(workflows.terminations.slice().sort()).toEqual(firstRuns.map(({ id }) => id).sort());
    expect((await env.RUNWAY_GITHUB_PROVIDER.state()).completions).toHaveLength(2);
  });
});

test("an unavailable fork is skipped before a Check or Workflow is created", async () => {
  const fork = { id: 202, name: "runway-fork", full_name: "contributor/runway-fork" };
  await env.RUNWAY_GITHUB_PROVIDER.configure({ unavailableRepositoryId: fork.id });

  const response = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174107",
    event: "pull_request",
    payload: pullRequestPayload("7".repeat(40), { number: 29, headRepository: fork }),
  });

  expect(response.status).toBe(202);
  await eventually(async () => {
    expect((await env.RUNWAY_GITHUB_PROVIDER.state()).tokens).toHaveLength(2);
  });
  expect((await env.RUNWAY_GITHUB_PROVIDER.state()).checks).toEqual([]);
  expect((await githubWorkflowProbeState()).creates).toEqual([]);
});

test("supersession remains the winner when an old fork preflight reports unavailable", async () => {
  const fork = { id: 203, name: "runway-fork", full_name: "contributor/runway-fork" };
  await env.RUNWAY_GITHUB_PROVIDER.configure({
    unavailableRepositoryId: fork.id,
    tokenDelayMs: 100,
  });
  await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174112",
    event: "pull_request",
    payload: pullRequestPayload("c".repeat(40), { number: 31, headRepository: fork }),
  });
  const latest = {
    deliveryId: "123e4567-e89b-42d3-a456-426614174113",
    event: "pull_request" as const,
    payload: pullRequestPayload("d".repeat(40), { number: 31, headRepository: fork }),
  };
  const admitted = await deliverGitHub(latest);
  const admittedRuns = (await admitted.json()) as { runs: Array<{ id: string }> };

  await eventually(async () => {
    expect((await env.RUNWAY_GITHUB_PROVIDER.state()).tokens).toHaveLength(4);
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect((await env.RUNWAY_GITHUB_PROVIDER.state()).checks).toEqual([]);
  expect((await env.RUNWAY_GITHUB_PROVIDER.state()).completions).toEqual([]);
  expect((await githubWorkflowProbeState()).creates).toEqual([]);
  const duplicate = await deliverGitHub(latest);
  expect(duplicate.status).toBe(202);
  await expect(duplicate.json()).resolves.toEqual(admittedRuns);
});

test("supersession during a checks-token await cannot restore queued over cancelled", async () => {
  await env.RUNWAY_GITHUB_PROVIDER.configure({ checkTokenDelayMs: 250 });
  const first = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174116",
    event: "pull_request",
    payload: pullRequestPayload("1".repeat(40), { number: 33 }),
  });
  const oldRuns = ((await first.json()) as { runs: Array<{ id: string }> }).runs;
  await eventually(async () => {
    expect(
      (await env.RUNWAY_GITHUB_PROVIDER.state()).tokenStarts.some(
        ({ purpose }) => purpose === "checks",
      ),
    ).toBe(true);
  });

  const second = await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174117",
    event: "pull_request",
    payload: pullRequestPayload("2".repeat(40), { number: 33 }),
  });
  const newRuns = ((await second.json()) as { runs: Array<{ id: string }> }).runs;
  await env.RUNWAY_GITHUB_PROVIDER.configure({ checkTokenDelayMs: 0 });

  await eventually(async () => {
    const provider = await env.RUNWAY_GITHUB_PROVIDER.state();
    const workflows = await githubWorkflowProbeState();
    const oldCheckIds = provider.checks
      .filter(({ externalId }) => oldRuns.some(({ id }) => id === externalId))
      .map(({ id }) => id);
    expect(
      provider.completions.filter(({ checkRunId }) => oldCheckIds.includes(checkRunId)),
    ).toHaveLength(2);
    expect(
      workflows.creates
        .filter(({ id }) => newRuns.some((run) => run.id === id))
        .map(({ id }) => id)
        .sort(),
    ).toEqual(newRuns.map(({ id }) => id).sort());
  });
  const provider = await env.RUNWAY_GITHUB_PROVIDER.state();
  expect(
    provider.checks
      .filter(({ externalId }) => oldRuns.some(({ id }) => id === externalId))
      .map(({ conclusion }) => conclusion),
  ).toEqual(["cancelled", "cancelled"]);
});

test("GitHub delivery detail and tombstone retain dedupe for exactly seven days then prune together", async () => {
  const deliveryId = "123e4567-e89b-42d3-a456-426614174108";
  const request = {
    deliveryId,
    event: "push" as const,
    payload: pushPayload("8".repeat(40), "refs/heads/develop"),
  };
  const first = await deliverGitHub(request);
  const firstRuns = ((await first.json()) as { runs: Array<{ id: string }> }).runs;
  await eventually(async () => {
    expect((await githubWorkflowProbeState()).creates).toHaveLength(2);
  });

  await env.RUNWAY_GITHUB_CLOCK.advance(7 * 24 * 60 * 60 * 1_000 + 1);
  await deliverGitHub({
    deliveryId: "123e4567-e89b-42d3-a456-426614174115",
    event: "push",
    payload: pushPayload("e".repeat(40), "refs/heads/prune-trigger"),
  });
  await eventually(async () => {
    expect((await githubWorkflowProbeState()).creates).toHaveLength(4);
  });
  await env.RUNWAY_GITHUB_CLOCK.reset();
  const replay = await deliverGitHub(request);
  const replayRuns = ((await replay.json()) as { runs: Array<{ id: string }> }).runs;

  expect(replayRuns).not.toEqual(firstRuns);
  await eventually(async () => {
    expect((await githubWorkflowProbeState()).creates).toHaveLength(6);
  });
});

test("a generated host reports only its no-cache deployment identity", async () => {
  const response = await env.GENERATED_HOST.fetch("https://runway.test/.runway/version");

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ deploymentId: env.ACTIVE_DEPLOYMENT_ID });
});

test("a generated host serves only content-addressed workflow caches", async () => {
  const digest = "c".repeat(64);
  const body = "cached toolchain";
  await env.RUNWAY_ARTIFACTS.put(`caches/${digest}.tar.gz`, body);

  const response = await env.GENERATED_HOST.fetch(
    `https://runway.test/.runway/cache/${digest}.tar.gz`,
  );
  expect(response.status).toBe(200);
  expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(body);
  expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(response.headers.get("content-type")).toBe("application/gzip");
  expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]+"$/);

  await expect(
    env.GENERATED_HOST.fetch(`https://runway.test/.runway/cache/${"d".repeat(64)}.tar.gz`),
  ).resolves.toMatchObject({ status: 404 });
  await expect(
    env.GENERATED_HOST.fetch("https://runway.test/.runway/cache/../artifacts/secret.json"),
  ).resolves.toMatchObject({ status: 404 });
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
    "sandbox-secret",
  );
  await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
});

test("GitHub run source passes its exact repository commit to the Sandbox instead of the artifact commit", async () => {
  await putActiveArtifact();
  const artifact = JSON.parse(env.ACTIVE_ARTIFACT) as { repository: { commit: string } };
  const source = githubRunSource();
  expect(artifact.repository.commit).not.toBe(source.commit);
  const runId = await createRepositoryProbeRun({
    artifactVersion: env.ACTIVE_ARTIFACT_VERSION,
    source,
  });
  await using instance = await introspectWorkflowInstance(env.REPOSITORY_PROBE_DYNAMIC, runId);

  const record = (await instance.waitForStepResult({ name: "record-issue" })) as {
    apiKey: string;
  };
  expect(JSON.parse(record.apiKey)).toEqual({
    remote: "https://github.com/casparbreloh/runway",
    commit: source.commit,
    authentication: {
      type: "github",
      installationId: source.installationId,
      repository: source.repository,
    },
  });
  await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
});

test("each nonsecret GitHub capability field isolates its Loader props at the same SHA", async () => {
  await putActiveArtifact();
  const source = {
    ...githubRunSource(),
    deliveryId: "123e4567-e89b-42d3-a456-426614174010",
    runId: "run-github-isolation",
  };
  const variants = [
    { ...source, runId: "run-github-another" },
    { ...source, deliveryId: "123e4567-e89b-42d3-a456-426614174011" },
    { ...source, check: { ...source.check, id: 502 } },
    { ...source, check: { ...source.check, name: "Test" } },
    { ...source, generation: 2 },
    { ...source, installationId: 43 },
    {
      ...source,
      repository: { id: 102, name: "runway-fork", fullName: "casparbreloh/runway-fork" },
    },
    {
      ...source,
      check: {
        ...source.check,
        repository: { id: 103, name: "runway-base", fullName: "casparbreloh/runway-base" },
      },
    },
  ];
  for (const candidate of [source, ...variants]) {
    const runId = await createRepositoryProbeRun({
      artifactVersion: env.ACTIVE_ARTIFACT_VERSION,
      source: candidate,
    });
    await using instance = await introspectWorkflowInstance(env.REPOSITORY_PROBE_DYNAMIC, runId);
    await expect(instance.waitForStepResult({ name: "run-loader-state" })).resolves.toBe(1);
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
  }
});

test("GitHub run metadata rejects extra and token-like capability fields", async () => {
  const source = githubRunSource();
  await expectGeneratedRunError(
    { artifactVersion: env.ACTIVE_ARTIFACT_VERSION, source: { ...source, token: "secret" } },
    "invalid workflow metadata",
  );
  await expectGeneratedRunError(
    { artifactVersion: env.ACTIVE_ARTIFACT_VERSION, source, unexpected: true },
    "invalid workflow metadata",
  );
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

test("a Dynamic Workflow rejects credentials embedded in an artifact repository descriptor", async () => {
  const active = JSON.parse(env.ACTIVE_ARTIFACT) as Record<string, unknown>;
  const repository = active.repository as {
    authentication: Record<string, unknown>;
  };
  const artifactVersion = await putArtifact(
    JSON.stringify({
      ...active,
      repository: {
        ...repository,
        authentication: { ...repository.authentication, token: "never-durable" },
      },
    }),
  );

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

test("a generated runtime binding returns only declared secrets", async () => {
  await expect(env.GENERATED_ISSUE_HOST.secrets()).resolves.toEqual({
    API_KEY: "test-api-key",
    HOOK_SECRET: "test-secret",
  });
});

test("a generated runtime binding returns its constructor-bound terminal identity", async () => {
  await expect(env.GENERATED_ISSUE_HOST.terminal("run-id")).resolves.toEqual({
    accountId: "test-account",
    repositoryId: `remote:${repositoryFixture.remote}`,
    workflowId: "issue-created",
    runId: "run-id",
    trustId: `remote:${repositoryFixture.remote}`,
    generation: 1,
  });
});

test("a generated runtime binding rejects invalid terminal control input", async () => {
  const probe = exports.CapabilityProbe({ props: {} });
  await expect(probe.invoke("startRun", [""])).resolves.toBe("invalid run lifecycle");
  await expect(
    probe.invoke("publishTerminal", ["run-id", { claimId: "", outcome: "success" }]),
  ).resolves.toBe("invalid terminal finalization");
  await expect(
    probe.invoke("publishTerminal", ["run-id", { claimId: "claim", outcome: "pending" }]),
  ).resolves.toBe("invalid terminal finalization");
  await expect(
    probe.invoke("publishTerminal", [
      "run-id",
      { claimId: "claim", outcome: "success", extra: true },
    ]),
  ).resolves.toBe("invalid terminal finalization");
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
