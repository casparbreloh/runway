import { github, workflow } from "runway";

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
  await ctx.step.exec("setup-pnpm", "npm install --global pnpm@11.5.0");
  await ctx.step.exec("install", "pnpm install --frozen-lockfile");
  await ctx.step.exec("format-check", "pnpm format-check");
  await ctx.step.exec("lint", "pnpm lint");
  await ctx.step.exec("typecheck", "pnpm typecheck");
  await ctx.step.exec("fallow", "pnpm fallow");
});
