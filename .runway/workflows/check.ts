import { github, workflow } from "runway";

import { installCiDependencies, setupCiToolchain } from "../ci.ts";

export default workflow({
  id: "check",
  trigger: () =>
    github({
      checkName: "Check",
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
  await ctx.step.exec("format-check", "pnpm format-check");
  await ctx.step.exec("lint", "pnpm lint");
  await ctx.step.exec("typecheck", "pnpm typecheck");
  await ctx.step.exec("fallow", "pnpm fallow");
});
