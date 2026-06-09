import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/deploy.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: "2026-06-06",
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["tests/worker.test.ts"],
        },
      },
    ],
  },
});
