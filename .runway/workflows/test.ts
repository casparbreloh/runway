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
  await ctx.step.exec(
    "setup-node",
    "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libatomic1 && npm install --global n && n 26.5.0",
  );
  await ctx.step.exec("setup-pnpm", "npm install --global pnpm@11.5.0");
  await ctx.step.exec("toolchain", "node --version && npm --version && pnpm --version");
  await ctx.step.exec(
    "install",
    "pnpm install --frozen-lockfile --reporter=append-only --child-concurrency=1 --network-concurrency=8",
  );
  await ctx.step.exec("test", "pnpm test");
});
