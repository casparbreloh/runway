import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { expect, test } from "vitest";

import { runLocal } from "../src/internal/local.ts";
import { cron, github } from "../src/trigger.ts";
import { workflow } from "../src/workflow.ts";

test("runs workflows locally regardless of their automatic trigger or tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "runway-local-"));
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  let calls = 0;
  const definition = workflow({
    id: "check",
    tools: { id: "cloud-only", setup: "exit 99" },
    trigger: () => github({ checkName: "Check", events: [{ type: "push", branches: ["main"] }] }),
  }).run(async (step, event) => {
    expect(event).toBeUndefined();
    await step.do("once", () => {
      calls += 1;
    });
    await expect(step.cache("cache", { key: "v1", paths: [".cache"] })).resolves.toEqual({
      state: "skipped",
      reason: "policy",
    });
    await expect(
      step.exec("echo", { command: 'printf "$CI:$VALUE"', env: { VALUE: "local" } }),
    ).resolves.toMatchObject({ stdout: "true:local", stderr: "", exitCode: 0 });
    await expect(
      step.exec("override", { command: 'printf "$CI"', env: { CI: "false" } }),
    ).resolves.toMatchObject({ stdout: "false" });
    await step.sleep("briefly", 1);
  });

  try {
    await runLocal(definition, {
      cwd,
      stdout,
    });
    expect(calls).toBe(1);
    expect(output).toBe("true:localfalse");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("passes an explicit event", async () => {
  const definition = workflow({
    id: "daily",
    trigger: () => cron("0 9 * * *"),
  }).run((_step, event) => {
    expect(event.scheduledTime).toBe(42);
  });

  await runLocal(definition, {
    cwd: process.cwd(),
    event: { cron: "0 9 * * *", scheduledTime: 42 },
  });
});

test("rejects declared secrets", async () => {
  const definition = workflow({ id: "secret", secrets: ["TOKEN"] as const }).run(() => {});
  await expect(runLocal(definition, { cwd: process.cwd() })).rejects.toThrow(
    "local workflows cannot declare secrets",
  );
});

test("cancels local command process groups", async () => {
  const controller = new AbortController();
  const definition = workflow({ id: "cancel" }).run(async (step) => {
    setTimeout(() => controller.abort(), 20);
    await step.exec("wait", "sleep 5");
  });

  await expect(
    runLocal(definition, { cwd: process.cwd(), signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
});
