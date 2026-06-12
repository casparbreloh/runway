import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

const repo = path.resolve(import.meta.dirname, "../../..");
const example = path.join(repo, "example");
const bin = path.join(repo, "packages/runway/bin/runway.ts");

const run = async (
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {},
  cwd = example,
): Promise<{ code: number | null; output: string }> => {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      RUNWAY_DISABLE_WRANGLER_AUTH: "1",
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

const project = async (
  files: Record<string, string>,
): Promise<{ cwd: string; cleanup(): Promise<void> }> => {
  const cwd = await mkdtemp(path.join(example, ".tmp-cli-test-"));
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), contents);
  }
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};

const workflow = (
  id: string,
  secrets: ReadonlyArray<string> = [],
): string => `import { cron, workflow } from "runway";

export const ${id.replaceAll("-", "_")} = workflow({
  id: ${JSON.stringify(id)},
  secrets: ${JSON.stringify(secrets)},
  trigger: () => cron("* * * * *"),
}).handler(async () => {});
`;

const defaultWorkflow = (
  id: string,
  secrets: ReadonlyArray<string> = [],
): string => `import { cron, workflow } from "runway";

export default workflow({
  id: ${JSON.stringify(id)},
  secrets: ${JSON.stringify(secrets)},
  trigger: () => cron("* * * * *"),
}).handler(async () => {});
`;

test("deploy reports missing required env vars before upload", async () => {
  const missingSecrets = await run(["deploy"], {
    CLOUDFLARE_API_TOKEN: "test-token",
    CLOUDFLARE_ACCOUNT_ID: "test-account",
  });
  const missingAll = await run(["deploy"]);

  expect(missingSecrets.code).toBe(1);
  expect(missingSecrets.output).toMatch(/runway: deploy failed/);
  expect(missingSecrets.output).toMatch(
    /missing required env var\(s\): LINEAR_WEBHOOK_SECRET, LINEAR_API_KEY, OPENROUTER_API_KEY/,
  );
  expect(missingAll.code).toBe(1);
  expect(missingAll.output).toMatch(/runway: deploy failed/);
  expect(missingAll.output).toMatch(
    /missing required env var\(s\): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, LINEAR_WEBHOOK_SECRET, LINEAR_API_KEY, OPENROUTER_API_KEY/,
  );
});

test("deploy discovers workflows without config", async () => {
  const app = await project({
    ".runway/workflows/hello.ts": defaultWorkflow("hello", ["HELLO_SECRET"]),
    ".runway/workflows/ignored.test.ts": workflow("ignored", ["IGNORED_SECRET"]),
  });

  try {
    const result = await run(
      ["deploy"],
      { CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ACCOUNT_ID: "test-account" },
      app.cwd,
    );

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/missing required env var\(s\): HELLO_SECRET/);
    expect(result.output).not.toMatch(/IGNORED_SECRET/);
  } finally {
    await app.cleanup();
  }
});

test("deploy only discovers fixed workflow path", async () => {
  const app = await project({
    ".runway/visible.ts": workflow("visible", ["VISIBLE_SECRET"]),
    ".runway/workflows/hello.ts": workflow("hello", ["HELLO_SECRET"]),
    ".runway/workflows/ignored.spec.ts": workflow("spec", ["SPEC_SECRET"]),
    ".runway/workflows/ignored.d.ts": workflow("types", ["TYPES_SECRET"]),
  });

  try {
    const result = await run(
      ["deploy"],
      { CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ACCOUNT_ID: "test-account" },
      app.cwd,
    );

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/missing required env var\(s\): HELLO_SECRET/);
    expect(result.output).not.toMatch(/VISIBLE_SECRET|SPEC_SECRET|TYPES_SECRET/);
  } finally {
    await app.cleanup();
  }
});

test("deploy supports barrel exports without duplicate registration", async () => {
  const app = await project({
    ".runway/workflows/hello.ts": workflow("hello", ["HELLO_SECRET"]),
    ".runway/workflows/index.ts": 'export { hello } from "./hello.ts";\n',
  });

  try {
    const result = await run(
      ["deploy"],
      { CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ACCOUNT_ID: "test-account" },
      app.cwd,
    );

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/missing required env var\(s\): HELLO_SECRET/);
  } finally {
    await app.cleanup();
  }
});

test("deploy errors when no workflows are discovered", async () => {
  const app = await project({
    ".runway/workflows/helper.ts": "export const helper = 1;\n",
  });

  try {
    const result = await run(["deploy"], {}, app.cwd);

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/no workflows found; checked 1 file\(s\)/);
  } finally {
    await app.cleanup();
  }
});

test("deploy errors on duplicate workflow ids", async () => {
  const app = await project({
    ".runway/workflows/one.ts": workflow("same"),
    ".runway/workflows/two.ts": workflow("same"),
  });

  try {
    const result = await run(["deploy"], {}, app.cwd);

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/duplicate workflow id "same"/);
  } finally {
    await app.cleanup();
  }
});

test("build is not a public command", async () => {
  const result = await run(["build"]);

  expect(result.code).toBe(1);
  expect(result.output).toMatch(/Unknown command/);
});
