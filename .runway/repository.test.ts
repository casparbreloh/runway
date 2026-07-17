import { describe, expect, test } from "vitest";

import type {
  CacheDeclaration,
  CacheResult,
  ExecOptions,
  ExecResult,
  Run,
  WorkflowDefinition,
} from "../packages/runway/src/index.ts";
import check from "./workflows/check.ts";
import testWorkflow from "./workflows/test.ts";

type Invocation =
  | { readonly type: "cache"; readonly id: string; readonly declaration: CacheDeclaration }
  | { readonly type: "exec"; readonly id: string; readonly command: string | ExecOptions };

const invoke = async (
  workflow: WorkflowDefinition,
  cacheResult: CacheResult = { state: "miss", reason: "absent" },
): Promise<readonly Invocation[]> => {
  const invocations: Invocation[] = [];
  const result: ExecResult = { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  const run: Run = {
    runId: "root-workflow",
    secrets: {},
    do: async (_id, work) => await work(),
    cache: async (id, declaration) => {
      invocations.push({ type: "cache", id, declaration });
      return cacheResult;
    },
    exec: async (id, command) => {
      invocations.push({ type: "exec", id, command });
      return result;
    },
    sleep: async () => {},
  };

  await workflow.run(run, undefined);
  return invocations;
};

const caches = (invocations: readonly Invocation[]): readonly Invocation[] =>
  invocations.filter((invocation) => invocation.type === "cache");

const execs = (
  invocations: readonly Invocation[],
): readonly Extract<Invocation, { readonly type: "exec" }>[] =>
  invocations.filter((invocation) => invocation.type === "exec");

describe("Runway's repository workflows", () => {
  test("Check and Test share exact-source toolchain and dependency caches before commands", async () => {
    const checkInvocations = await invoke(check);
    const testInvocations = await invoke(testWorkflow);
    const expected = [
      {
        type: "cache",
        id: "toolchain",
        declaration: {
          key: { files: [".runway/repository.ts", "package.json"] },
          path: "/cache/runway-ci-toolchain",
        },
      },
      {
        type: "cache",
        id: "dependencies",
        declaration: {
          key: {
            files: [
              ".runway/repository.ts",
              "package.json",
              "packages/runway/package.json",
              "pnpm-lock.yaml",
              "pnpm-workspace.yaml",
            ],
          },
          path: "/cache/runway-ci-pnpm-store",
        },
      },
      {
        type: "cache",
        id: "node-modules",
        declaration: {
          key: {
            files: [
              ".runway/repository.ts",
              "package.json",
              "packages/runway/package.json",
              "pnpm-lock.yaml",
              "pnpm-workspace.yaml",
            ],
          },
          path: "/workspace/node_modules",
        },
      },
    ];

    expect(caches(checkInvocations)).toEqual(expected);
    expect(caches(testInvocations)).toEqual(expected);
    expect(checkInvocations.slice(0, 3)).toEqual(expected);
    expect(testInvocations.slice(0, 3)).toEqual(expected);
  });

  test("a cold Check and Test preserve the repository CI command sequence", async () => {
    const checkCommands = execs(await invoke(check));
    const testCommands = execs(await invoke(testWorkflow));

    expect(checkCommands.map(({ id }) => id)).toEqual([
      "setup-node",
      "setup-pnpm",
      "toolchain",
      "install",
      "format-check",
      "lint",
      "typecheck",
      "fallow",
      "clean-dependencies",
    ]);
    expect(testCommands.map(({ id }) => id)).toEqual([
      "setup-node",
      "setup-pnpm",
      "toolchain",
      "install",
      "test",
      "clean-dependencies",
    ]);
    expect(checkCommands.slice(-5, -1).map(({ command }) => command)).toEqual([
      expect.objectContaining({ command: "pnpm format-check" }),
      expect.objectContaining({ command: "pnpm lint" }),
      expect.objectContaining({ command: "pnpm typecheck" }),
      expect.objectContaining({ command: "pnpm fallow" }),
    ]);
    expect(testCommands.at(-2)?.command).toEqual(
      expect.objectContaining({
        command: "pnpm test",
        env: expect.objectContaining({ VITEST_MAX_WORKERS: "1" }),
      }),
    );
  });

  test("a warm run after pre-command replacement validates node_modules and skips install", async () => {
    const invocations = await invoke(check, { state: "hit", bytes: 4096 });
    const install = execs(invocations).find(({ id }) => id === "install");

    expect(invocations.slice(0, 3).every(({ type }) => type === "cache")).toBe(true);
    expect(install?.command).toEqual(
      expect.objectContaining({
        command: expect.stringContaining(
          "test -x node_modules/.bin/oxfmt && test -x node_modules/.bin/oxlint",
        ),
      }),
    );
    expect((install?.command as ExecOptions | undefined)?.command).not.toContain("pnpm install");
    expect((install?.command as ExecOptions | undefined)?.command).toContain(
      "ln -s ../packages/runway node_modules/runway",
    );
    expect((install?.command as ExecOptions | undefined)?.env).toEqual(
      expect.objectContaining({ pnpm_config_verify_deps_before_run: "false" }),
    );
  });

  test("a node_modules miss installs the hoisted tree and success removes its workspace link", async () => {
    const invocations = await invoke(check, { state: "miss", reason: "absent" });
    const install = execs(invocations).find(({ id }) => id === "install");
    const command = (install?.command as ExecOptions | undefined)?.command;

    expect(command).toContain("pnpm install --frozen-lockfile");
    expect(command).toContain("--node-linker=hoisted");
    expect(command).toContain("--store-dir /cache/runway-ci-pnpm-store");
    expect(command).not.toContain("tar ");
    expect(execs(invocations).at(-1)).toEqual(
      expect.objectContaining({
        id: "clean-dependencies",
        command: expect.objectContaining({ command: "rm -f node_modules/runway" }),
      }),
    );
  });

  test("repository setup pins and verifies Node, pnpm, and the Linux runtime library", async () => {
    const setup = execs(await invoke(check)).find(({ id }) => id === "setup-node");

    expect(setup?.command).toEqual(
      expect.objectContaining({
        command: expect.stringContaining(
          "https://nodejs.org/dist/v26.5.0/node-v26.5.0-linux-x64.tar.gz",
        ),
        env: expect.objectContaining({
          LD_LIBRARY_PATH: "/cache/runway-ci-toolchain/lib",
          PATH: expect.stringMatching(/^\/cache\/runway-ci-toolchain\/node\/bin:/),
        }),
        timeoutMs: 15 * 60_000,
      }),
    );
    expect(setup?.command).toEqual(
      expect.objectContaining({
        command: expect.stringContaining(
          "22b5f47ad6ae78837e4c2b846019965ce1a06ba143de176102294a1bf44fc677",
        ),
      }),
    );
    expect(setup?.command).toEqual(
      expect.objectContaining({
        command: expect.stringContaining("https://registry.npmjs.org/pnpm/-/pnpm-11.5.0.tgz"),
      }),
    );
    expect(setup?.command).toEqual(
      expect.objectContaining({
        command: expect.stringContaining(
          "a282871708f87a47b9cd72182dfdf9ee251c69100b8bac862a3d4f5e2145d8ff",
        ),
      }),
    );
    expect(setup?.command).toEqual(
      expect.objectContaining({
        command: expect.stringContaining(
          "56573c81b5dd84817882400cfea49fe671f5e6cfdd0f88b5d3a894c08b150462",
        ),
      }),
    );
  });
});
