import { introspectWorkflow } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, expect, test, vi } from "vitest";

const testRunner = exports.TestRunner({ props: {} });

beforeEach(async () => {
  await testRunner.reset();
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
    expect(await testRunner.state()).toEqual({
      executions: [
        {
          runId: run.id,
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

test("runner startup is lazy and workspaces are reused per run but isolated between runs", async () => {
  const introspector = await introspectWorkflow(env.RUNNER);
  try {
    const lazy = await env.RUNNER.create({ params: { commands: [] } });
    const first = await env.RUNNER.create({ params: { commands: ["true", "true"] } });
    const second = await env.RUNNER.create({ params: { commands: ["true"] } });
    const instances = introspector.get();

    await Promise.all(instances.map(async (instance) => await instance.waitForStatus("complete")));
    const state = await testRunner.state();
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
    expect((await testRunner.state()).executions).toHaveLength(1);
    expect((await testRunner.state()).destroys).toEqual([run.id]);
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
    expect((await testRunner.state()).destroys).toEqual([run.id]);
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
      expect((await testRunner.state()).executions).toHaveLength(1);
    });

    await run.terminate();
    await expect(instance!.waitForStatus("terminated")).resolves.not.toThrow();
    await vi.waitFor(async () => {
      const state = await testRunner.state();
      expect(state.kills).toEqual([run.id]);
      expect(state.destroys).toEqual([run.id]);
    });
  } finally {
    await introspector.dispose();
  }
});
