import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["src/codegen.test.ts", "src/deploy.test.ts"],
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
          include: ["src/router.test.ts", "src/testing.test.ts"],
        },
      },
    ],
  },
});
