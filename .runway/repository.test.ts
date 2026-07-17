import { describe, expect, test } from "vitest";

import type {
  CacheDeclaration,
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

const invoke = async (workflow: WorkflowDefinition): Promise<readonly Invocation[]> => {
  const invocations: Invocation[] = [];
  const result: ExecResult = { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  const run: Run = {
    runId: "root-workflow",
    secrets: {},
    do: async (_id, work) => await work(),
    cache: async (id, declaration) => {
      invocations.push({ type: "cache", id, declaration });
      return { state: "miss", reason: "absent" };
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
  test("Check and Test do not declare repository-specific caches", async () => {
    const checkInvocations = await invoke(check);
    const testInvocations = await invoke(testWorkflow);

    expect(caches(checkInvocations)).toEqual([]);
    expect(caches(testInvocations)).toEqual([]);
    expect(checkInvocations.at(0)).toEqual(
      expect.objectContaining({ type: "exec", id: "setup-node" }),
    );
    expect(testInvocations.at(0)).toEqual(
      expect.objectContaining({ type: "exec", id: "setup-node" }),
    );
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
    ]);
    expect(testCommands.map(({ id }) => id)).toEqual([
      "setup-node",
      "setup-pnpm",
      "toolchain",
      "install",
      "test",
    ]);
    expect(checkCommands.slice(-4).map(({ command }) => command)).toEqual([
      expect.objectContaining({ command: "pnpm format-check" }),
      expect.objectContaining({ command: "pnpm lint" }),
      expect.objectContaining({ command: "pnpm typecheck" }),
      expect.objectContaining({ command: "pnpm fallow" }),
    ]);
    expect(testCommands.at(-1)?.command).toEqual(
      expect.objectContaining({
        command: "pnpm test",
        env: expect.objectContaining({ VITEST_MAX_WORKERS: "1" }),
      }),
    );
  });

  test("repository setup always performs a frozen hoisted install", async () => {
    const invocations = await invoke(check);
    const install = execs(invocations).find(({ id }) => id === "install");
    const command = (install?.command as ExecOptions | undefined)?.command;

    expect(command).toContain("pnpm install --frozen-lockfile");
    expect(command).toContain("--node-linker=hoisted");
    expect(command).toContain("--store-dir /cache/runway-ci-pnpm-store");
    expect(command).not.toContain("--offline");
    expect((install?.command as ExecOptions | undefined)?.env).toEqual(
      expect.objectContaining({ NODE_OPTIONS: "--max-old-space-size=128" }),
    );
  });

  test("repository setup does not retain cache-publication cleanup", async () => {
    const invocations = await invoke(check);
    const install = execs(invocations).find(({ id }) => id === "install");
    const command = (install?.command as ExecOptions | undefined)?.command;

    expect(command).not.toContain("tar ");
    expect(execs(invocations).some(({ id }) => id === "clean-dependencies")).toBe(false);
    expect(
      execs(invocations).some(({ command: value }) =>
        typeof value === "string"
          ? value.includes("rm -f node_modules/runway")
          : value.command.includes("rm -f node_modules/runway"),
      ),
    ).toBe(false);
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
