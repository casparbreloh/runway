import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "runway-node",
    include: [
      "tests/cli.test.ts",
      "tests/cloudflare-sandbox.test.ts",
      "tests/deploy.test.ts",
      "tests/github.test.ts",
      "tests/sandbox.test.ts",
      "tests/terminal.test.ts",
      "tests/workflow.test.ts",
    ],
    testTimeout: 20_000,
  },
});
