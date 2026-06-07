import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const stub = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Cloudflare runtime modules aren't available under Node; alias them to stubs so the SDK
// graph imports cleanly for the (pure-logic) router tests.
export default defineConfig({
  test: {
    alias: {
      "cloudflare:workers": stub("./tests/stubs/cf-workers.ts"),
      "cloudflare:workflows": stub("./tests/stubs/cf-workflows.ts"),
      "@cloudflare/sandbox": stub("./tests/stubs/cf-sandbox.ts"),
    },
  },
});
