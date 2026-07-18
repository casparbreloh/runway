import { defineToolProvider, mise, release } from "runway";
import { expect, test } from "vitest";

import { withTools } from "../src/internal/tool/execution.ts";
import type { CacheDeclaration, ExecOptions, ExecResult } from "../src/step.ts";

test("tool providers restore every private cache before setup and prepare once", async () => {
  const calls: string[] = [];
  const operations = {
    cache: async (id: string, _declaration: CacheDeclaration) => {
      calls.push(`cache:${id}`);
      return { state: "miss" as const, reason: "absent" as const };
    },
    exec: async (id: string, command: string | ExecOptions): Promise<ExecResult> => {
      calls.push(`exec:${id}:${typeof command === "string" ? command : command.command}`);
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

  expect(calls.slice(0, 4).map((call) => call.split(":setup:")[0])).toEqual([
    "cache:runway:tools:first:cache",
    "cache:runway:tools:second:cache",
    "exec:runway:tools:first",
    "exec:runway:tools:second",
  ]);
  expect(calls[2]).toContain("setup-first");
  expect(calls[3]).toContain("setup-second");
  expect(calls[4]).toContain("export PATH='/cache/first/bin:/cache/second/bin':\"$PATH\"");
  expect(calls[4]).toContain("export FIRST='yes'");
  expect(calls.filter((call) => call.includes(":setup:"))).toHaveLength(2);
});

test("mise supports repository discovery and inline tools behind the same provider seam", () => {
  const discovered = mise();
  const inline = mise({ node: "24.5.0", pnpm: "10.13.1" });

  expect(discovered.id).toBe("mise");
  expect(discovered.cache).toMatchObject({
    paths: ["/cache/runway/tools/mise"],
    key: { prefix: expect.stringContaining("repository") },
  });
  expect(discovered.setup).toContain("mise.lock");
  expect(inline.setup).toContain('[tools]\n"node" = "24.5.0"');
  expect(inline.cache?.key).toEqual(expect.stringMatching(/^runway-mise-v2026\.7\.7-inline-/));
  expect(inline.env).toMatchObject({
    MISE_CONFIG_FILE: "/cache/runway/tools/mise/config.toml",
  });
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
