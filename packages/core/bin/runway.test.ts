import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

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

void test("build prints concise progress", async () => {
  const result = await run(["build"]);

  assert.equal(result.code, 0);
  assert.match(result.output, /Build \.\.\./);
  assert.match(result.output, /Build done/);
  assert.match(result.output, /Built 1 workflow\(s\)/);
});

void test("deploy reports missing webhook secrets before upload", async () => {
  const result = await run(["deploy"], {
    CLOUDFLARE_API_TOKEN: "test-token",
    CLOUDFLARE_ACCOUNT_ID: "test-account",
  });

  assert.equal(result.code, 1);
  assert.match(result.output, /runway: deploy failed/);
  assert.match(result.output, /missing webhook secret env var\(s\): LINEAR_WEBHOOK_SECRET/);
});

void test("deploy reports missing Cloudflare credentials clearly", async () => {
  const result = await run(["deploy"]);

  assert.equal(result.code, 1);
  assert.match(result.output, /runway: deploy failed/);
  assert.match(
    result.output,
    /missing Cloudflare env var\(s\): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID/,
  );
});
