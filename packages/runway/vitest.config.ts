import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "runway-node",
    include: [
      "tests/cache.test.ts",
      "tests/cli.test.ts",
      "tests/cloudflare-cache.test.ts",
      "tests/cloudflare-cache-snapshot.test.ts",
      "tests/cloudflare-sandbox.test.ts",
      "tests/deploy.test.ts",
      "tests/github.test.ts",
      "tests/meter.test.ts",
      "tests/sandbox.test.ts",
      "tests/stack.test.ts",
      "tests/terminal.test.ts",
      "tests/workflow.test.ts",
    ],
    testTimeout: 20_000,
  },
});
