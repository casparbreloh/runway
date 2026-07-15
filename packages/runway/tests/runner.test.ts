import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import * as runtime from "runway/runtime";
import { beforeEach, expect, test, vi } from "vitest";

const testRunner = exports.TestRunner({ props: {} });
const adapterHarness = exports.RunnerAdapterHarness({ props: {} });
const disposable = <T>(result: Promise<T>): Promise<T> & Disposable =>
  result as Promise<T> & Disposable;

beforeEach(async () => {
  await testRunner.reset();
  await exports
    .TestHost({
      props: {
        secrets: {
          API_KEY: "test-api-key",
          HOOK_SECRET: "test-secret",
          RUNNER_SECRET: "runner-secret",
        },
      },
    })
    .resetSecret();
});

test("generated workers receive one runner adapter without low-level runner exports", () => {
  expect(Object.keys(runtime).sort()).toEqual(["createWorkflowWorker", "toEntrypoint"]);
});

test("exec supports shorthand, options, defaults, and declared-secret redaction input", async () => {
  const introspector = await introspectWorkflow(env.RUNNER);
  try {
    const run = await env.RUNNER.create({
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
    using stateResult = disposable(testRunner.state());
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
          secrets: ["runner-secret"],
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
          secrets: ["runner-secret"],
        },
      ],
      destroys: [run.id],
      kills: [],
    });
  } finally {
    await introspector.dispose();
  }
});

test("a retried command reconnects to its deterministic process without starting a duplicate", async () => {
  using result = disposable(adapterHarness.retry());
  await expect(result).resolves.toEqual({
    result: { exitCode: 0, stdout: "recovered\n", stderr: "", durationMs: expect.any(Number) },
    starts: 1,
    streams: 2,
  });
});

test("large command output is incrementally streamed into bounded redacted tails", async () => {
  using result = disposable(adapterHarness.boundedOutput());
  const execution = (await result) as {
    result: { stdout: string; stderr: string };
    stdoutBytes: number;
    pulls: number;
    logsContainSecret: boolean;
    logsContainMask: boolean;
  };

  expect(execution.pulls).toBeGreaterThan(20);
  expect(execution.stdoutBytes).toBe(64 * 1024);
  expect(execution.result.stderr).toBe("bad ***\n");
  expect(execution.result.stdout).not.toContain("streaming-secret");
  expect(execution.logsContainSecret).toBe(false);
  expect(execution.logsContainMask).toBe(true);
});

test("all Sandbox boundary exceptions redact declared secrets and command text", async () => {
  using result = disposable(adapterHarness.sandboxErrors());
  const errors = await result;

  expect(errors).toEqual([
    expect.objectContaining({ stage: "sandbox", name: "Error", message: "sandbox exposed ***" }),
    expect.objectContaining({
      stage: "getProcess",
      name: "Error",
      message: "getProcess exposed ***",
    }),
    expect.objectContaining({
      stage: "startProcess",
      name: "Error",
      message: "startProcess exposed ***",
    }),
    expect.objectContaining({ stage: "destroy", message: "destroy exposed ***" }),
  ]);
  expect(JSON.stringify(errors)).not.toContain("sandbox-secret");
});

test("a timeout kills the deterministic command process group", async () => {
  using result = disposable(adapterHarness.timeout());
  const outcome = (await result) as {
    error: string;
    commands: string[];
    killed: Array<{ id: string; signal?: string }>;
  };

  expect(outcome.error).toBe("command timed out after 5ms");
  expect(outcome.commands[0]).toContain("setsid sh -c");
  expect(outcome.commands[0]).toContain("trap cleanup EXIT");
  expect(outcome.commands[0]).toContain('wait "$child"');
  expect(outcome.commands).toHaveLength(1);
  expect(outcome.killed[0]?.id).toMatch(/^step-[0-9a-f]{32}$/);
  expect(outcome.killed[0]?.signal).toBeUndefined();
});

test("the runner adapter polls termination and destroys an active Sandbox", async () => {
  using result = disposable(adapterHarness.terminationCleanup());
  await expect(result).resolves.toEqual({
    result: { exitCode: 137, stdout: "", stderr: "", durationMs: expect.any(Number) },
    kills: 1,
    destroys: 1,
    watcherError: "termination exposed ***",
  });
});

test("runner startup is lazy and workspaces are reused per run but isolated between runs", async () => {
  const introspector = await introspectWorkflow(env.RUNNER);
  try {
    const lazy = await env.RUNNER.create({ params: { commands: [] } });
    const first = await env.RUNNER.create({ params: { commands: ["true", "true"] } });
    const second = await env.RUNNER.create({ params: { commands: ["true"] } });
    const instances = introspector.get();

    await Promise.all(instances.map(async (instance) => await instance.waitForStatus("complete")));
    using stateResult = disposable(testRunner.state());
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

test("a live runner keeps workspace files across durable sleep", async () => {
  const introspector = await introspectWorkflow(env.RUNNER);
  try {
    await env.RUNNER.create({
      params: {
        commands: ["echo hello > state.txt", "cat state.txt"],
        pauseMs: 20,
      },
    });
    const [instance] = introspector.get();

    await expect(instance!.waitForStepResult({ name: "command-1" })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "hello\n",
    });
  } finally {
    await introspector.dispose();
  }
});

test("a Sandbox restart between commands loses the best-effort workspace", async () => {
  const introspector = await introspectWorkflow(env.RUNNER);
  try {
    const run = await env.RUNNER.create({
      params: {
        commands: ["echo hello > state.txt", "cat state.txt"],
        pauseMs: 100,
        catchErrors: true,
      },
    });
    const [instance] = introspector.get();
    await instance!.waitForStepResult({ name: "command-0" });
    await testRunner.restart(run.id);

    await expect(instance!.waitForStepResult({ name: "command-1" })).resolves.toMatchObject({
      exitCode: 1,
      stderr: "cat: state.txt: No such file\n",
    });
  } finally {
    await introspector.dispose();
  }
});

test("non-zero execution is recorded once, throws a typed error, and cleans up", async () => {
  const introspector = await introspectWorkflow(env.RUNNER);
  try {
    const run = await env.RUNNER.create({ params: { commands: ["exit 7"], catchErrors: true } });
    const [instance] = introspector.get();

    await expect(instance!.waitForStepResult({ name: "command-0" })).resolves.toMatchObject({
      exitCode: 7,
    });
    await expect(instance!.waitForStepResult({ name: "caught-error" })).resolves.toEqual({
      name: "ExecError",
      typed: true,
    });
    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();
    using stateResult = disposable(testRunner.state());
    const state = await stateResult;
    expect(state.executions).toHaveLength(1);
    expect(state.destroys).toEqual([run.id]);
  } finally {
    await introspector.dispose();
  }
});

test("a non-zero command redacts declared secrets from its command and ExecError", async () => {
  const introspector = await introspectWorkflow(env.RUNNER);
  try {
    await env.RUNNER.create({
      params: { commands: ["leak runner-secret"], catchErrors: true },
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
    expect(JSON.stringify(error)).not.toContain("runner-secret");
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
        RUNNER_SECRET: "runner-secret",
      },
    },
  });
  try {
    await env.SECRET_SNAPSHOT.create({ params: {} });
    const [instance] = introspector.get();
    await expect(
      instance!.waitForStepResult({ name: "runway:secret-snapshot" }),
    ).resolves.not.toContain("runner-secret");
    await expect(instance!.waitForStepResult({ name: "resolved-secret" })).resolves.toBe(
      "runner-secret",
    );
    await host.rotateSecret("rotated-secret");

    await expect(instance!.waitForStepResult({ name: "snapshot-output" })).resolves.toMatchObject({
      stdout: "***",
    });
    await expect(instance!.waitForStatus("complete")).resolves.not.toThrow();
    await expect(host.destroySecrets()).resolves.toEqual(["runner-secret"]);
  } finally {
    await introspector.dispose();
  }
});

test("an errored workflow cleans up its runner workspace", async () => {
  const introspector = await introspectWorkflow(env.RUNNER);
  try {
    const run = await env.RUNNER.create({ params: { commands: ["exit 7"] } });
    const [instance] = introspector.get();

    await expect(instance!.waitForStatus("errored")).resolves.not.toThrow();
    using stateResult = disposable(testRunner.state());
    expect((await stateResult).destroys).toEqual([run.id]);
  } finally {
    await introspector.dispose();
  }
});

test("a failed cleanup remains retryable during Workflow rollback", async () => {
  const introspector = await introspectWorkflow(env.RUNNER);
  try {
    await testRunner.failDestroyOnce();
    const run = await env.RUNNER.create({ params: { commands: ["true"] } });
    const [instance] = introspector.get();

    await expect(instance!.waitForStatus("errored")).resolves.not.toThrow();
    await vi.waitFor(async () => {
      expect(await testRunner.destroyAttempts()).toBe(2);
      using stateResult = disposable(testRunner.state());
      expect((await stateResult).destroys).toEqual([run.id]);
    });
  } finally {
    await introspector.dispose();
  }
});

test("terminating a workflow cancels active execution and cleans up its workspace", async () => {
  const introspector = await introspectWorkflow(env.RUNNER);
  try {
    const run = await env.RUNNER.create({ params: { commands: ["block"] } });
    const [instance] = introspector.get();
    await vi.waitFor(async () => {
      using stateResult = disposable(testRunner.state());
      expect((await stateResult).executions).toHaveLength(1);
    });

    await run.terminate();
    await expect(instance!.waitForStatus("terminated")).resolves.not.toThrow();
    await vi.waitFor(async () => {
      using stateResult = disposable(testRunner.state());
      const state = await stateResult;
      expect(state.kills).toEqual([run.id]);
      expect(state.destroys).toEqual([run.id]);
    });
  } finally {
    await introspector.dispose();
  }
});
