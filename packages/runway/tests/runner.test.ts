import type { ExecResult } from "runway";
import { expect, test } from "vitest";

import {
  DEFAULT_EXEC_CWD,
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_OUTPUT_CHARS,
  ManagedRunner,
  executeCommand,
} from "../src/runner.ts";
import type { RunnerBridge, SandboxExecutor } from "../src/runner.ts";

const success: ExecResult = { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 8 };

test("managed execution applies defaults and supports option overrides", async () => {
  const calls: unknown[][] = [];
  const bridge: RunnerBridge = {
    exec: async (...args) => {
      calls.push(args);
      return success;
    },
    destroy: async () => {},
  };
  const runner = new ManagedRunner(bridge, "run-one", ["secret"]);

  await runner.exec("install", "pnpm install --frozen-lockfile");
  await runner.exec("test", {
    command: "pnpm test",
    cwd: "packages/app",
    env: { NODE_ENV: "test" },
    timeoutMs: 1_200_000,
  });

  expect(calls).toEqual([
    [
      "run-one",
      {
        command: "pnpm install --frozen-lockfile",
        cwd: DEFAULT_EXEC_CWD,
        env: { CI: "true" },
        timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
      },
      ["secret"],
    ],
    [
      "run-one",
      {
        command: "pnpm test",
        cwd: "packages/app",
        env: { CI: "true", NODE_ENV: "test" },
        timeoutMs: 1_200_000,
      },
      ["secret"],
    ],
  ]);
});

test("runner startup is lazy, reuses a run workspace, isolates runs, and cleans up once", async () => {
  const executions: string[] = [];
  const destroys: string[] = [];
  const bridge: RunnerBridge = {
    exec: async (runId) => {
      executions.push(runId);
      return success;
    },
    destroy: async (runId) => {
      destroys.push(runId);
    },
  };
  const first = new ManagedRunner(bridge, "run-one", []);
  const second = new ManagedRunner(bridge, "run-two", []);

  await first.cleanup();
  expect(destroys).toEqual([]);
  await first.exec("one", "true");
  await first.exec("two", "true");
  await second.exec("one", "true");
  await first.cleanup();
  await first.cleanup();
  await second.cleanup();

  expect(executions).toEqual(["run-one", "run-one", "run-two"]);
  expect(destroys).toEqual(["run-one", "run-two"]);
});

test("failed or cancelled execution remains eligible for runner cleanup", async () => {
  const destroys: string[] = [];
  const bridge: RunnerBridge = {
    exec: async () => {
      throw new Error("cancelled");
    },
    destroy: async (runId) => {
      destroys.push(runId);
    },
  };
  const runner = new ManagedRunner(bridge, "run-cancelled", []);

  await expect(runner.exec("long", "sleep 60")).rejects.toThrow("cancelled");
  await runner.cleanup();

  expect(destroys).toEqual(["run-cancelled"]);
});

test("replayed durable execution remains eligible for runner cleanup", async () => {
  const destroys: string[] = [];
  const bridge: RunnerBridge = {
    exec: async () => success,
    destroy: async (runId) => {
      destroys.push(runId);
    },
  };
  const runner = new ManagedRunner(bridge, "run-replayed", []);

  runner.activate();
  await runner.cleanup();

  expect(destroys).toEqual(["run-replayed"]);
});

test("non-zero and timed out commands throw typed errors with bounded results", async () => {
  const bridge: RunnerBridge = {
    exec: async () => ({ exitCode: 7, stdout: "tail", stderr: "failed", durationMs: 4 }),
    destroy: async () => {},
  };
  const runner = new ManagedRunner(bridge, "run-one", []);

  await expect(runner.exec("test", "pnpm test")).rejects.toMatchObject({
    name: "ExecError",
    id: "test",
    command: "pnpm test",
    result: { exitCode: 7 },
    timedOut: false,
  });
});

test("sandbox timeout is distinguished from an intentional exit code 124", async () => {
  const results: ExecResult[] = [
    {
      exitCode: 124,
      stdout: "",
      stderr: "Command timed out after 900000ms\n",
      durationMs: 900_000,
    },
    { exitCode: 124, stdout: "", stderr: "intentional\n", durationMs: 1 },
  ];
  const bridge: RunnerBridge = {
    exec: async () => results.shift()!,
    destroy: async () => {},
  };
  const runner = new ManagedRunner(bridge, "run-one", []);

  await expect(runner.exec("timeout", "sleep 9999")).rejects.toMatchObject({ timedOut: true });
  await expect(runner.exec("exit", "exit 124")).rejects.toMatchObject({ timedOut: false });
});

test("sandbox execution streams redacted logs and returns only bounded redacted tails", async () => {
  const logs: Array<["stdout" | "stderr", string]> = [];
  const secret = "super-secret";
  const repeated = "x".repeat(MAX_EXEC_OUTPUT_CHARS + 100);
  const sandbox: SandboxExecutor = {
    exec: async (_command, options) => {
      options.onOutput("stdout", `${repeated}${secret.slice(0, 5)}`);
      options.onOutput("stdout", `${secret.slice(5)}\n`);
      options.onOutput("stderr", `bad ${secret}\n`);
      return { exitCode: 0, duration: 9 };
    },
  };

  const result = await executeCommand(
    sandbox,
    {
      command: "echo",
      cwd: "/workspace",
      env: { CI: "true" },
      timeoutMs: 100,
    },
    [secret],
    (stream, chunk) => logs.push([stream, chunk]),
  );

  expect(logs.map((entry) => entry[1]).join("")).not.toContain(secret);
  expect(logs.map((entry) => entry[1]).join("")).toContain("***");
  expect(result).toEqual({
    exitCode: 0,
    stdout: `${"x".repeat(MAX_EXEC_OUTPUT_CHARS - 4)}***\n`,
    stderr: "bad ***\n",
    durationMs: 9,
  });
  expect(result.stdout.length).toBe(MAX_EXEC_OUTPUT_CHARS);
});
