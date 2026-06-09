import { spawn } from "node:child_process";
import path from "node:path";

import { expect, test } from "vitest";

const repo = path.resolve(import.meta.dirname, "../../..");
const example = path.join(repo, "example");
const bin = path.join(repo, "packages/core/bin/runway.ts");

const run = async (
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {},
): Promise<{ code: number | null; output: string }> => {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd: example,
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      ...env,
    },
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });
  return { code, output: Buffer.concat(chunks).toString("utf8") };
};

test("build prints concise progress", async () => {
  const result = await run(["build"]);

  expect(result.code).toBe(0);
  expect(result.output).toMatch(/Loading\.\.\./);
  expect(result.output).toMatch(/Loaded\./);
  expect(result.output).toMatch(/Building\.\.\./);
  expect(result.output).toMatch(/Built\./);
  expect(result.output).toMatch(/Built 1 workflow\(s\)/);
});

test("deploy reports missing webhook secrets before upload", async () => {
  const result = await run(["deploy"], {
    CLOUDFLARE_API_TOKEN: "test-token",
    CLOUDFLARE_ACCOUNT_ID: "test-account",
  });

  expect(result.code).toBe(1);
  expect(result.output).toMatch(/runway: deploy failed/);
  expect(result.output).toMatch(/missing required env var\(s\): LINEAR_WEBHOOK_SECRET/);
});

test("deploy reports all missing env vars clearly", async () => {
  const result = await run(["deploy"]);

  expect(result.code).toBe(1);
  expect(result.output).toMatch(/runway: deploy failed/);
  expect(result.output).toMatch(
    /missing required env var\(s\): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, LINEAR_WEBHOOK_SECRET/,
  );
});
