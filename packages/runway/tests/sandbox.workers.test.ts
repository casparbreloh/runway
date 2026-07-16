import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as runtime from "runway/runtime";
import { beforeEach, expect, test, vi } from "vitest";

import { repositoryFixture } from "./repository-fixture.ts";

const testSandbox = exports.TestSandbox({ props: {} });
const disposable = <T>(result: Promise<T>): Promise<T> & Disposable =>
  result as Promise<T> & Disposable;

beforeEach(async () => {
  await testSandbox.reset();
  await exports
    .TestHost({
      props: {
        secrets: {
          API_KEY: "test-api-key",
          HOOK_SECRET: "test-secret",
          SANDBOX_SECRET: "sandbox-secret",
        },
      },
    })
    .resetSecret();
});

test("generated workers expose only the workflow runtime API", () => {
  expect(Object.keys(runtime).sort()).toEqual(["createWorkflowWorker", "toEntrypoint"]);
});

test("exec supports shorthand, options, defaults, and declared-secret redaction input", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    const run = await env.COMMANDS.create({
      params: {
        commands: [
          "pnpm install --frozen-lockfile",
          {
            command: "pnpm test",
            cwd: "packages/app",
            env: { NODE_ENV: "test" },
            timeoutMs: 1_200_000,
          },
        ],
      },
    });
    const [instance] = introspector.get();

    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();
    using stateResult = disposable(testSandbox.state());
    expect(await stateResult).toEqual({
      executions: [
        {
          runId: run.id,
          step: { id: "command-0", count: 1, attempt: 1 },
          options: {
            command: "pnpm install --frozen-lockfile",
            cwd: "/workspace",
            env: { CI: "true" },
            timeoutMs: 15 * 60_000,
          },
          secrets: ["sandbox-secret"],
        },
        {
          runId: run.id,
          step: { id: "command-1", count: 1, attempt: 1 },
          options: {
            command: "pnpm test",
            cwd: "packages/app",
            env: { CI: "true", NODE_ENV: "test" },
            timeoutMs: 1_200_000,
          },
          secrets: ["sandbox-secret"],
        },
      ],
      destroys: [run.id],
      kills: [],
    });
  } finally {
    await introspector.dispose();
  }
});

test("a confirmed timeout is durably recorded once and keeps its original outcome", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    const run = await env.COMMANDS.create({
      params: { commands: ["confirmed-timeout"], catchErrors: true },
    });
    const [instance] = introspector.get();

    await expect(instance!.waitForStepResult({ name: "command-0" })).resolves.toMatchObject({
      timeout: { message: "command timed out after 25ms", attempt: 1 },
    });
    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();
    using stateResult = disposable(testSandbox.state());
    expect(
      (await stateResult).executions.map(({ runId, step, options }) => ({
        runId,
        attempt: step.attempt,
        command: options.command,
      })),
    ).toEqual([{ runId: run.id, attempt: 1, command: "confirmed-timeout" }]);
  } finally {
    await introspector.dispose();
  }
});

test("the Workflow host prepares only its exact credential-free source capability", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    await env.COMMANDS.create({ params: { commands: ["git rev-parse HEAD"] } });
    const [instance] = introspector.get();
    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();

    using sourceStateResult = disposable(testSandbox.sourceState());
    const requests = (await sourceStateResult) as Array<Record<string, unknown>>;
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!).sort()).toEqual([
      "allowReconstruct",
      "runId",
      "secrets",
      "source",
    ]);
    expect(requests[0]!.allowReconstruct).toBe(true);
    expect(requests[0]!.source).toEqual({
      repositoryId: `remote:${repositoryFixture.remote}`,
      remote: repositoryFixture.remote,
      revision: repositoryFixture.commit,
    });
    expect(JSON.stringify(requests)).not.toMatch(/credential|token|password|authorization/i);
  } finally {
    await introspector.dispose();
  }
});

test("a cache hit inspects the exact run source and completes before the first exec", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  const host = exports.TestHost({
    props: {
      secrets: {
        API_KEY: "test-api-key",
        HOOK_SECRET: "test-secret",
        SANDBOX_SECRET: "sandbox-secret",
      },
    },
  });
  try {
    await env.COMMANDS.create({
      params: {
        caches: [
          {
            id: "tree",
            declaration: {
              key: { files: ["missing.input", "present.input"], salt: "v1" },
              path: "/cache/tree",
            },
          },
          { id: "archive", declaration: { key: "hit", path: "/cache/archive" } },
        ],
        commands: ["true"],
      },
    });
    const [instance] = introspector.get();
    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();
    using cacheStateResult = disposable(host.cacheState());
    const state = (await cacheStateResult) as {
      requests: unknown[];
      fileInspections: unknown[];
    };
    expect(state.requests).toHaveLength(2);
    expect(state.requests[0]).toMatchObject({
      id: "tree",
      declaration: { key: { files: ["missing.input", "present.input"], salt: "v1" } },
      source: { result: { revision: repositoryFixture.commit } },
    });
    expect(state.fileInspections).toEqual([
      { path: "missing.input", revision: repositoryFixture.commit },
      { path: "present.input", revision: repositoryFixture.commit },
    ]);
    using lifecycleResult = disposable(host.lifecycleEvents());
    const lifecycle = await lifecycleResult;
    expect(lifecycle.indexOf(`cache:hit:${repositoryFixture.commit}`)).toBeGreaterThan(-1);
    expect(lifecycle.indexOf("exec:true")).toBeGreaterThan(
      lifecycle.indexOf(`cache:hit:${repositoryFixture.commit}`),
    );
  } finally {
    await introspector.dispose();
  }
});

test("Sandbox startup is lazy and workspaces are reused per run but isolated between runs", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    const lazy = await env.COMMANDS.create({ params: { commands: [] } });
    const first = await env.COMMANDS.create({ params: { commands: ["true", "true"] } });
    const second = await env.COMMANDS.create({ params: { commands: ["true"] } });
    const instances = introspector.get();

    await Promise.all(instances.map(async (instance) => await instance.waitForStatus("complete")));
    using stateResult = disposable(testSandbox.state());
    const state = await stateResult;
    const firstId = first.id;
    const secondId = second.id;
    expect(state.executions.filter(({ runId }) => runId === firstId)).toHaveLength(2);
    expect(state.executions.filter(({ runId }) => runId === secondId)).toHaveLength(1);
    expect(state.destroys).toHaveLength(2);
    expect(state.destroys).toEqual(expect.arrayContaining([firstId, secondId]));
    expect(state.destroys).not.toContain(lazy.id);
  } finally {
    await introspector.dispose();
  }
});

test("a live Sandbox keeps workspace files across durable sleep", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    await env.COMMANDS.create({
      params: {
        commands: ["echo hello > state.txt", "cat state.txt"],
        pauseMs: 20,
      },
    });
    const [instance] = introspector.get();

    await expect(instance!.waitForStepResult({ name: "command-1" })).resolves.toMatchObject({
      result: { exitCode: 0, stdout: "hello\n" },
    });
  } finally {
    await introspector.dispose();
  }
});

test("non-zero execution is recorded once, throws a typed error, and cleans up", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    const run = await env.COMMANDS.create({ params: { commands: ["exit 7"], catchErrors: true } });
    const [instance] = introspector.get();

    await expect(instance!.waitForStepResult({ name: "command-0" })).resolves.toMatchObject({
      result: { exitCode: 7 },
    });
    await expect(instance!.waitForStepResult({ name: "caught-error" })).resolves.toEqual({
      name: "ExecError",
      typed: true,
    });
    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();
    using stateResult = disposable(testSandbox.state());
    const state = await stateResult;
    expect(state.executions).toHaveLength(1);
    expect(state.destroys).toEqual([run.id]);
  } finally {
    await introspector.dispose();
  }
});

test("an ambiguous start latches loss across durable retries and later authored commands", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    const run = await env.COMMANDS.create({
      params: { commands: ["ambiguous-start", "must-not-start"], catchErrors: true },
    });
    const [instance] = introspector.get();

    await expect(instance!.waitForStepResult({ name: "command-0" })).resolves.toMatchObject({
      lost: {
        message: "run continuity was lost: ambiguous command start",
        attempt: 1,
      },
    });
    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();
    using stateResult = disposable(testSandbox.state());
    const state = await stateResult;
    expect(
      state.executions.map(({ runId, options }) => ({ runId, command: options.command })),
    ).toEqual([{ runId: run.id, command: "ambiguous-start" }]);
    using sourceStateResult = disposable(testSandbox.sourceState());
    expect(await sourceStateResult).toHaveLength(1);
  } finally {
    await introspector.dispose();
  }
});

test("a non-zero command redacts declared secrets from its command and ExecError", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    await env.COMMANDS.create({
      params: { commands: ["leak sandbox-secret"], catchErrors: true },
    });
    const [instance] = introspector.get();

    const error = await instance!.waitForStepResult({ name: "caught-error" });
    expect(error).toEqual({
      name: "ExecError",
      message: 'command "command-0" exited with code 9: leak ***',
      command: "leak ***",
      stdout: "stdout ***",
      stderr: "stderr ***",
    });
    expect(JSON.stringify(error)).not.toContain("sandbox-secret");
  } finally {
    await introspector.dispose();
  }
});

test("a run keeps one secret snapshot when the host binding rotates before exec", async () => {
  const introspector = await introspectWorkflow(env.SECRET_SNAPSHOT);
  const host = exports.TestHost({
    props: {
      secrets: {
        API_KEY: "test-api-key",
        HOOK_SECRET: "test-secret",
        SANDBOX_SECRET: "sandbox-secret",
      },
    },
  });
  try {
    await env.SECRET_SNAPSHOT.create({ params: {} });
    const [instance] = introspector.get();
    await expect(
      instance!.waitForStepResult({ name: "runway:secret-snapshot" }),
    ).resolves.not.toContain("sandbox-secret");
    await expect(instance!.waitForStepResult({ name: "resolved-secret" })).resolves.toBe(
      "sandbox-secret",
    );
    await host.rotateSecret("rotated-secret");

    await expect(instance!.waitForStepResult({ name: "snapshot-output" })).resolves.toMatchObject({
      result: { stdout: "***" },
    });
    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();
    await expect(host.destroySecrets()).resolves.toEqual(["sandbox-secret"]);
  } finally {
    await introspector.dispose();
  }
});

test("an errored workflow cleans up its Sandbox workspace", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    const run = await env.COMMANDS.create({ params: { commands: ["exit 7"] } });
    const [instance] = introspector.get();

    await expect(instance!.waitForStatus("errored")).resolves.not.toThrow();
    using stateResult = disposable(testSandbox.state());
    expect((await stateResult).destroys).toEqual([run.id]);
  } finally {
    await introspector.dispose();
  }
});

test("a failed cleanup remains retryable during Workflow rollback", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    await testSandbox.failDestroyOnce();
    const run = await env.COMMANDS.create({ params: { commands: ["true"] } });
    const [instance] = introspector.get();

    await expect(instance!.waitForStatus("errored")).resolves.not.toThrow();
    await vi.waitFor(async () => {
      expect(await testSandbox.destroyAttempts()).toBe(2);
      using stateResult = disposable(testSandbox.state());
      expect((await stateResult).destroys).toEqual([run.id]);
    });
  } finally {
    await introspector.dispose();
  }
});

test("terminating a workflow cancels active execution and cleans up its workspace", async () => {
  const introspector = await introspectWorkflow(env.COMMANDS);
  try {
    const run = await env.COMMANDS.create({ params: { commands: ["block"] } });
    const [instance] = introspector.get();
    await vi.waitFor(async () => {
      using stateResult = disposable(testSandbox.state());
      expect((await stateResult).executions).toHaveLength(1);
    });

    await run.terminate();
    await expect(instance!.waitForStatus("terminated")).resolves.not.toThrow();
    await vi.waitFor(async () => {
      using stateResult = disposable(testSandbox.state());
      const state = await stateResult;
      expect(state.kills).toEqual([run.id]);
      expect(state.destroys).toEqual([run.id]);
    });
  } finally {
    await introspector.dispose();
  }
});
