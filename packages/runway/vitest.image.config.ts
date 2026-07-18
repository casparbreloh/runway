import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "runway-image",
    include: ["tests/adapter/snapshot.image.test.ts"],
    testTimeout: 300_000,
  },
});
