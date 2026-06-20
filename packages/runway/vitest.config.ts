import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { COMPATIBILITY_DATE } from "./src/codegen.ts";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    projects: [
      {
        test: {
          name: "node",
          include: [
            "tests/cli.test.ts",
            "tests/deploy.test.ts",
            "tests/naming.test.ts",
            "tests/workflow.test.ts",
          ],
          testTimeout: 20_000,
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: COMPATIBILITY_DATE,
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["tests/worker.test.ts"],
          testTimeout: 20_000,
        },
      },
    ],
  },
});
