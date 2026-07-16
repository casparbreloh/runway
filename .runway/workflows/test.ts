import { github, workflow } from "runway";

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
  await ctx.step.exec("setup-pnpm", "npm install --global pnpm@11.5.0");
  await ctx.step.exec("install", "pnpm install --frozen-lockfile");
  await ctx.step.exec("test", "pnpm test");
});
