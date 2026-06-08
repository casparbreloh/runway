import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Cloudflare runtime modules aren't available under Node; alias them to stubs (the router
// tests are pure logic). "runway" resolves to the workspace package source.
export default defineConfig({
  test: {
    alias: {
      "cloudflare:workers": at("./tests/stubs/cf-workers.ts"),
      "cloudflare:workflows": at("./tests/stubs/cf-workflows.ts"),
      "@cloudflare/sandbox": at("./tests/stubs/cf-sandbox.ts"),
      runway: at("./packages/runway/src/index.ts"),
    },
  },
});
