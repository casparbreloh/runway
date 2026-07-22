import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "runway-e2e",
    include: [
      "tests/adapter/snapshot.image.test.ts",
      "tests/e2e/cache-transfer.e2e.ts",
      "tests/e2e/artifact-recovery.e2e.ts",
      "tests/e2e/repository-recovery.e2e.ts",
      "tests/e2e/github-recovery.e2e.ts",
    ],
    fileParallelism: false,
    testTimeout: 0,
  },
});
