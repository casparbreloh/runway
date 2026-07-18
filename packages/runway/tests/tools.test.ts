import { cron, defineToolProvider, mise, release, workflow, type ToolProvider } from "runway";
import { expect, test } from "vitest";

import { withTools } from "../src/internal/tool.ts";
import type { CacheDeclaration, ExecOptions, ExecResult } from "../src/step.ts";

test("tool providers restore every private cache before setup and prepare once", async () => {
  const calls: { readonly id: string; readonly cwd?: string }[] = [];
  const operations = {
    cache: async (id: string, _declaration: CacheDeclaration) => {
      calls.push({ id });
      return { state: "miss" as const, reason: "absent" as const };
    },
    exec: async (id: string, command: string | ExecOptions): Promise<ExecResult> => {
      calls.push({
        id,
        ...(typeof command === "string" || !command.cwd ? {} : { cwd: command.cwd }),
      });
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    },
  };
  const tools = [
    defineToolProvider({
      id: "first",
      cache: { key: "first", paths: ["/cache/first"] },
      setup: "setup-first",
      paths: ["/cache/first/bin"],
      env: { FIRST: "yes" },
    }),
    defineToolProvider({
      id: "second",
      cache: { key: "second", paths: ["/cache/second"] },
      setup: "setup-second",
      paths: ["/cache/second/bin"],
    }),
  ];

  const runtime = withTools(operations, tools);
  await runtime.exec("check", "which first");
  await runtime.exec("test", { command: "first --version", cwd: "/workspace/example" });

  expect(calls.map(({ id }) => id)).toEqual([
    "runway:tools:first:cache",
    "runway:tools:second:cache",
    "runway:tools:first:setup",
    "runway:tools:second:setup",
    "check",
    "test",
  ]);
  expect(calls.at(-1)).toMatchObject({ cwd: "/workspace/example" });
});

test("mise supports repository discovery and inline tools behind the same provider seam", () => {
  const discovered = mise();
  const inline = mise({ node: "24.5.0", pnpm: "10.13.1" });

  expect(discovered.id).toBe("mise");
  expect(discovered.cache).toBeUndefined();
  expect(inline.cache).toBeUndefined();
  expect(inline.env).toMatchObject({
    MISE_CONFIG_FILE: "/cache/runway/tools/mise/config.toml",
  });
});

test("workflow definitions own an immutable normalized provider snapshot", () => {
  const provider = {
    id: "mutable",
    cache: {
      key: { prefix: "v1-", files: ["lock"] as [string, ...string[]] },
      paths: ["/cache/mutable"] as [string, ...string[]],
      restoreKeys: ["v1-"],
    },
    setup: { command: "setup", env: { MODE: "original" } },
    paths: ["/cache/mutable/bin"],
    env: { TOOL_MODE: "original" },
  };
  const providers = [provider];
  const definition = workflow({
    id: "immutable-tools",
    tools: providers,
    trigger: () => cron("* * * * *"),
  }).run(async () => {});

  provider.cache.paths[0] = "/cache/changed";
  provider.setup.env.MODE = "changed";
  provider.paths[0] = "/cache/changed/bin";
  provider.env.TOOL_MODE = "changed";
  providers.length = 0;

  const normalized = (definition.tools as readonly ToolProvider[])[0]!;
  expect(normalized).toMatchObject({
    cache: { paths: ["/cache/mutable"] },
    setup: { env: { MODE: "original" } },
    paths: ["/cache/mutable/bin"],
    env: { TOOL_MODE: "original" },
  });
  expect([
    definition.tools,
    normalized,
    normalized.cache,
    normalized.cache?.paths,
    normalized.setup,
    typeof normalized.setup === "string" ? undefined : normalized.setup.env,
  ]).toSatisfy((values: readonly unknown[]) =>
    values.every((value) => value === undefined || Object.isFrozen(value)),
  );
});

test("a native release is another ordinary cached provider", () => {
  const provider = release({
    name: "aube",
    version: "1.2.3",
    url: "https://example.com/aube.tar.gz",
    sha256: "a".repeat(64),
    executable: "dist/aube",
  });

  expect(provider).toMatchObject({
    id: "release-aube",
    cache: {
      key: `runway-release-aube-1.2.3-${"a".repeat(64)}-dist/aube`,
      paths: ["/cache/runway/tools/release/aube"],
    },
    paths: ["/cache/runway/tools/release/aube/bin"],
  });
});
