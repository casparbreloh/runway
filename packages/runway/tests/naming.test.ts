import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import { resolveScriptName } from "../src/naming.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const example = path.join(repo, "example");

const project = async (
  files: Record<string, string> = {},
): Promise<{ cwd: string; cleanup(): Promise<void> }> => {
  const cwd = await mkdtemp(path.join(example, ".tmp-naming-test-"));
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), contents);
  }
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};

test("resolves an explicit script name override as a direct slug", async () => {
  const app = await project({
    "package.json": JSON.stringify({ name: "ship-it" }),
  });

  try {
    await expect(
      resolveScriptName({
        cwd: app.cwd,
        env: { RUNWAY_SCRIPT_NAME: "  Custom_Runway/Prod  " },
      }),
    ).resolves.toBe("custom-runway-prod");
  } finally {
    await app.cleanup();
  }
});

test("uses the package name before the cwd basename", async () => {
  for (const [packageName, expected] of [
    ["ship-it", "runway-ship-it"],
    ["@Acme/Ship It", "runway-acme-ship-it"],
    ["runway-platform", "runway-platform"],
  ] as const) {
    const app = await project({
      "package.json": JSON.stringify({ name: packageName }),
    });

    try {
      await expect(resolveScriptName({ cwd: app.cwd, env: {} })).resolves.toBe(expected);
    } finally {
      await app.cleanup();
    }
  }
});

test("falls back to the cwd basename when package name is missing", async () => {
  const root = await project();
  const cwd = path.join(root.cwd, "My Repo!");
  await mkdir(cwd);

  try {
    await expect(resolveScriptName({ cwd, env: {} })).resolves.toBe("runway-my-repo");
  } finally {
    await root.cleanup();
  }
});

test("rejects names that cannot produce a slug", async () => {
  const app = await project();

  try {
    await expect(
      resolveScriptName({ cwd: app.cwd, env: { RUNWAY_SCRIPT_NAME: "!!!" } }),
    ).rejects.toThrow('invalid Runway script name "!!!"');
  } finally {
    await app.cleanup();
  }
});

test("rejects names that exceed workers.dev DNS label limits", async () => {
  const app = await project({
    "package.json": JSON.stringify({ name: "a".repeat(58) }),
  });

  try {
    await expect(
      resolveScriptName({ cwd: app.cwd, env: { RUNWAY_SCRIPT_NAME: "a".repeat(64) } }),
    ).rejects.toThrow("exceeds 63 characters");
    await expect(resolveScriptName({ cwd: app.cwd, env: {} })).rejects.toThrow(
      "exceeds 63 characters",
    );
  } finally {
    await app.cleanup();
  }
});

test("does not fall back to cwd basename when package.json is malformed", async () => {
  const app = await project({
    "package.json": "{",
  });

  try {
    await expect(resolveScriptName({ cwd: app.cwd, env: {} })).rejects.toThrow();
  } finally {
    await app.cleanup();
  }
});
