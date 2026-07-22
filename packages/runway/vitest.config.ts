import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "runway-node",
    include: [
      "tests/cache.test.ts",
      "tests/cli.test.ts",
      "tests/adapter/transfer.test.ts",
      "tests/adapter/snapshot.test.ts",
      "tests/adapter/cloudflare.test.ts",
      "tests/adapter/sandbox.test.ts",
      "tests/adapter/stack.test.ts",
      "tests/publish.test.ts",
      "tests/github.test.ts",
      "tests/local.test.ts",
      "tests/meter.test.ts",
      "tests/sandbox.test.ts",
      "tests/stack.test.ts",
      "tests/terminal.test.ts",
      "tests/tools.test.ts",
      "tests/workflow.test.ts",
    ],
    testTimeout: 20_000,
  },
});
