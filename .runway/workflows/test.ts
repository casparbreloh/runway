import { github, workflow } from "runway";

import { installCiDependencies, setupCiToolchain } from "../ci.ts";

export default workflow({
  id: "test",
  trigger: () =>
    github({
      checkName: "Test",
      events: [
        { type: "push", branches: ["main"] },
        { type: "pull_request", actions: ["opened", "reopened", "synchronize"] },
      ],
    }),
}).handler(async (ctx) => {
  await ctx.step.exec("setup-node", setupCiToolchain);
  await ctx.step.exec("setup-pnpm", "pnpm --version");
  await ctx.step.exec("toolchain", "node --version && npm --version && pnpm --version");
  await ctx.step.exec("install", installCiDependencies);
  await ctx.step.exec("test", "pnpm test");
});
