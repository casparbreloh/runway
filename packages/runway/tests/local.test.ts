import { expect, test } from "vitest";

import { cron, defineToolProvider, workflow } from "../src/index.ts";
import { runLocal } from "../src/internal/local.ts";
import type { ExecOptions, ExecResult } from "../src/step.ts";

test("a local run carries workflow behavior through the Step and tool-provider seams", async () => {
  const commands: Array<string | ExecOptions> = [];
  let destroyed = false;
  let slept = 0;
  const definition = workflow({
    id: "local",
    secrets: ["TOKEN"],
    tools: defineToolProvider({ id: "fixture", setup: "prepare", env: { TOOL: "ready" } }),
    trigger: () => cron("* * * * *"),
  }).run(async (step, event) => {
    expect(step.secrets.TOKEN).toBe("secret");
    expect(event).toEqual({ value: 1 });
    await step.do("request", async () => "done");
    await expect(
      step.cache("cache", { key: "fixture", paths: ["/cache/fixture"] }),
    ).resolves.toEqual({ state: "skipped", reason: "policy" });
    await step.exec("first", "check");
    await step.exec("second", { command: "test", env: { LOCAL: "yes" } });
    await step.sleep("pause", 7);
  });

  const result = await runLocal(definition, {
    cwd: "/workspace",
    env: { TOKEN: "secret" },
    event: { value: 1 },
    container: {
      exec: async (command): Promise<ExecResult> => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
      destroy: async () => {
        destroyed = true;
      },
    },
    now: (() => {
      let value = 0;
      return () => (value += 5);
    })(),
    wait: async (durationMs) => {
      slept = durationMs;
    },
  });

  expect(commands).toHaveLength(3);
  expect(commands[0]).toMatchObject({ command: expect.stringContaining("prepare") });
  expect(commands[1]).toMatchObject({
    command: expect.stringContaining("check"),
    cwd: "/workspace",
    env: { CI: "true" },
    timeoutMs: 15 * 60_000,
  });
  expect(commands[2]).toMatchObject({
    command: expect.stringContaining("test"),
    env: { LOCAL: "yes" },
  });
  expect(slept).toBe(7);
  expect(destroyed).toBe(true);
  expect(result).toMatchObject({ runId: expect.stringMatching(/^local-/), durationMs: 5 });
});

test.each([0, Number.POSITIVE_INFINITY])(
  "a local run rejects invalid timeout %s",
  async (timeoutMs) => {
    let destroyed = false;
    const definition = workflow({ id: "invalid", trigger: () => cron("* * * * *") }).run(
      async (step) => {
        await step.exec("invalid", { command: "check", timeoutMs });
      },
    );

    await expect(
      runLocal(definition, {
        cwd: "/workspace",
        env: {},
        event: {},
        container: {
          exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
          destroy: async () => {
            destroyed = true;
          },
        },
      }),
    ).rejects.toThrow("exec timeoutMs must be a positive finite number");
    expect(destroyed).toBe(true);
  },
);
