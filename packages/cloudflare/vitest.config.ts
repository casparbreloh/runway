import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { COMPATIBILITY_DATE } from "./src/codegen.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/deploy.test.ts"],
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
