import { expect, test } from "vitest";

import { executeSandboxCommand, MAX_EXEC_OUTPUT_CHARS } from "../src/command-output.ts";

test("sandbox output is streamed redacted and returned as bounded redacted tails", async () => {
  const logs: Array<["stdout" | "stderr", string]> = [];
  const secret = "super-secret";
  const repeated = "x".repeat(MAX_EXEC_OUTPUT_CHARS + 100);
  let timeout: number | undefined;
  const sandbox: Parameters<typeof executeSandboxCommand>[0] = {
    exec: async (_command, options) => {
      timeout = options.timeout;
      options.onOutput("stdout", `${repeated}${secret.slice(0, 5)}`);
      options.onOutput("stdout", `${secret.slice(5)}\n`);
      options.onOutput("stderr", `bad ${secret}\n`);
      return { exitCode: 0, duration: 9 };
    },
    killAllProcesses: async () => {},
  };

  const result = await executeSandboxCommand(
    sandbox,
    { command: "echo", cwd: "/workspace", env: { CI: "true" }, timeoutMs: 100 },
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
  expect(timeout).toBe(100);
});

test("a timed-out or cancelled sandbox command terminates its process tree", async () => {
  let killed = 0;
  const sandbox = {
    exec: async () => {
      throw new Error("execution timed out");
    },
    killAllProcesses: async () => {
      killed += 1;
    },
  };

  await expect(
    executeSandboxCommand(
      sandbox,
      { command: "sleep 60", cwd: "/workspace", env: { CI: "true" }, timeoutMs: 100 },
      [],
      () => {},
    ),
  ).rejects.toThrow("execution timed out");
  expect(killed).toBe(1);
});
