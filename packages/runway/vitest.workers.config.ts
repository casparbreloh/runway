import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { COMPATIBILITY_DATE } from "./src/codegen.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./tests/runtime-worker.ts",
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        bindings: {
          API_KEY: "test-api-key",
          HOOK_SECRET: "test-secret",
        },
        workflows: {
          DAILY: {
            name: "daily-test",
            className: "DailyWorkflow",
          },
          ISSUE_CREATED: {
            name: "issue-created-test",
            className: "IssueCreatedWorkflow",
          },
        },
      },
    }),
  ],
  test: {
    name: "runway-workers",
    include: ["tests/worker.test.ts"],
    testTimeout: 20_000,
  },
});
