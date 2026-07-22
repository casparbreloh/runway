import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import { loadRegistry } from "../src/internal/publish/registry.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const fixtureRoot = path.join(repo, "packages/runway");
const bin = path.join(repo, "packages/runway/bin/runway.ts");

const run = async (
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {},
  cwd = repo,
): Promise<{ code: number | null; output: string }> => {
  const child = spawn(process.execPath, [bin, ...args], {
    cwd,
    env: {
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
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
  const cwd = await mkdtemp(path.join(fixtureRoot, ".tmp-cli-test-"));
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), contents);
  }
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};

test("init works offline, creates one workflow without ingress, and preserves existing files", async () => {
  const app = await project({});
  const example = path.join(app.cwd, ".runway/workflows/example.ts");
  const existing = path.join(app.cwd, ".runway/workflows/existing.ts");

  try {
    const first = await run(["init"], { PATH: "" }, app.cwd);

    expect(first.code, first.output).toBe(0);
    expect(first.output).toMatch(/Created \.runway\/workflows\/example\.ts/);
    expect(await readdir(path.dirname(example))).toEqual(["example.ts"]);
    const registered = await loadRegistry(app.cwd);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.def.id).toBe("example");
    expect(registered[0]!.def.trigger).toBeUndefined();

    await writeFile(example, "custom example\n");
    await writeFile(existing, "existing workflow\n");
    const second = await run(["init"], {}, app.cwd);

    expect(second.code, second.output).toBe(0);
    expect(second.output).toMatch(/Preserved \.runway\/workflows\/example\.ts/);
    expect(await readFile(example, "utf8")).toBe("custom example\n");
    expect(await readFile(existing, "utf8")).toBe("existing workflow\n");
  } finally {
    await app.cleanup();
  }
});

test("init rejects unexpected arguments without creating files", async () => {
  const app = await project({});
  try {
    const result = await run(["init", "unexpected"], {}, app.cwd);

    expect(result.code, result.output).toBe(1);
    expect(result.output).toMatch(/usage: runway init/);
    await expect(
      readFile(path.join(app.cwd, ".runway/workflows/example.ts")),
    ).rejects.toBeDefined();
  } finally {
    await app.cleanup();
  }
});

test("run executes triggered workflows locally without requiring an event", async () => {
  const app = await project({
    ".runway/workflows/check.ts": `import { github, mise, workflow } from "runway";
export default workflow({
  id: "check",
  tools: mise(),
  trigger: () => github({ checkName: "Check", events: [{ type: "push", branches: ["main"] }] }),
}).run(async (step) => {
  await step.exec("check", 'printf "local check"');
});
`,
  });
  try {
    const result = await run(["run", "check"], {}, app.cwd);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toBe("local check");
  } finally {
    await app.cleanup();
  }
});

test("run reads an optional event JSON file", async () => {
  const app = await project({
    ".runway/workflows/event.ts": `import { cron, workflow } from "runway";
export default workflow({ id: "event", trigger: () => cron("0 9 * * *") }).run(
  async (step, event) => await step.exec("event", \`printf "${"${event.scheduledTime}"}"\`),
);
`,
    "event.json": JSON.stringify({ cron: "0 9 * * *", scheduledTime: 42 }),
  });
  try {
    const result = await run(["run", "event", "--event", "event.json"], {}, app.cwd);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toBe("42");
  } finally {
    await app.cleanup();
  }
});

test("secrets set validates command shape before auth", async () => {
  const invalidName = await run(["secrets", "set", "not-valid", "value"]);
  const missingValue = await run(["secrets", "set", "LINEAR_API_KEY"]);
  const extraArg = await run(["secrets", "set", "LINEAR_API_KEY", "value", "extra"]);
  const reserved = await run(["secrets", "set", "RUNWAY_SECRET_SNAPSHOT_KEY", "value"]);

  expect(invalidName.code).toBe(1);
  expect(invalidName.output).toMatch(/runway: secrets failed/);
  expect(invalidName.output).toMatch(/invalid workflow secret "not-valid"/);
  expect(missingValue.code).toBe(1);
  expect(missingValue.output).toMatch(/usage: runway secrets set <name> <value>/);
  expect(extraArg.code).toBe(1);
  expect(extraArg.output).toMatch(/usage: runway secrets set <name> <value>/);
  expect(reserved.code).toBe(1);
  expect(reserved.output).toMatch(/secret "RUNWAY_SECRET_SNAPSHOT_KEY" is reserved by Runway/);
});
