import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

const repo = path.resolve(import.meta.dirname, "../../..");
const example = path.join(repo, "example");
const bin = path.join(repo, "packages/core/bin/runway.ts");

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

const workflow = (id: string): string => `import { cron, workflow } from "@runway/core";

export const ${id.replaceAll("-", "_")} = workflow({
  id: ${JSON.stringify(id)},
  trigger: () => cron("* * * * *"),
}).handler(async () => {});
`;

const defaultWorkflow = (id: string): string => `import { cron, workflow } from "@runway/core";

export default workflow({
  id: ${JSON.stringify(id)},
  trigger: () => cron("* * * * *"),
}).handler(async () => {});
`;

const config = (body = ""): string => `import { defineConfig } from "@runway/core";

export default defineConfig({
  backend: {
    deploy: async (registry) => {
      throw new Error(
        "registry:" + registry.map((w) => w.path + "#" + w.exportName + "=" + w.def.id).join(","),
      );
    },
  },
  ${body}
});
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

test("deploy discovers default workflow includes", async () => {
  const app = await project({
    "runway.config.ts": config(),
    ".runway/workflows/hello.ts": defaultWorkflow("hello"),
    ".runway/workflows/ignored.test.ts": workflow("ignored"),
  });

  try {
    const result = await run(["deploy"], {}, app.cwd);

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/registry:\.runway\/workflows\/hello\.ts#default=hello/);
    expect(result.output).not.toMatch(/ignored/);
  } finally {
    await app.cleanup();
  }
});

test("deploy falls back to .runway config", async () => {
  const app = await project({
    ".runway/runway.config.ts": config(),
    ".runway/workflows/hello.ts": workflow("hello"),
  });

  try {
    const result = await run(["deploy"], {}, app.cwd);

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/registry:\.runway\/workflows\/hello\.ts#hello=hello/);
  } finally {
    await app.cleanup();
  }
});

test("deploy supports barrel exports without duplicate registration", async () => {
  const app = await project({
    "runway.config.ts": config(),
    ".runway/workflows/hello.ts": workflow("hello"),
    ".runway/workflows/index.ts": 'export { hello } from "./hello.ts";\n',
  });

  try {
    const result = await run(["deploy"], {}, app.cwd);

    expect(result.code).toBe(1);
    expect(result.output.match(/=hello/g)).toHaveLength(1);
  } finally {
    await app.cleanup();
  }
});

test("deploy supports custom include and exclude", async () => {
  const app = await project({
    "runway.config.ts": config('include: [".runway/*.ts"], exclude: [".runway/private.ts"],'),
    ".runway/visible.ts": workflow("visible"),
    ".runway/private.ts": workflow("private"),
    ".runway/workflows/ignored.ts": workflow("ignored"),
  });

  try {
    const result = await run(["deploy"], {}, app.cwd);

    expect(result.code).toBe(1);
    expect(result.output).toMatch(/registry:\.runway\/visible\.ts#visible=visible/);
    expect(result.output).not.toMatch(/private|ignored/);
  } finally {
    await app.cleanup();
  }
});

test("deploy errors when no workflows are discovered", async () => {
  const app = await project({
    "runway.config.ts": config(),
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
    "runway.config.ts": config(),
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
