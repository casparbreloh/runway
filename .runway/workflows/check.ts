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
  await ctx.step.exec(
    "setup-node",
    "curl -fsSL https://security.ubuntu.com/ubuntu/pool/main/g/gcc-12/libatomic1_12.3.0-1ubuntu1~22.04.3_amd64.deb -o /tmp/libatomic1.deb && echo '56573c81b5dd84817882400cfea49fe671f5e6cfdd0f88b5d3a894c08b150462  /tmp/libatomic1.deb' | sha256sum --check --status && rm -rf /tmp/runway-libatomic && mkdir /tmp/runway-libatomic && dpkg-deb --extract /tmp/libatomic1.deb /tmp/runway-libatomic && cp -a /tmp/runway-libatomic/usr/lib/x86_64-linux-gnu/libatomic.so.1* /usr/local/lib/ && ldconfig && npm install --global n && n 26.5.0",
  );
  await ctx.step.exec("setup-pnpm", "npm install --global pnpm@11.5.0");
  await ctx.step.exec("toolchain", "node --version && npm --version && pnpm --version");
  await ctx.step.exec(
    "install",
    "pnpm install --frozen-lockfile --reporter=append-only --child-concurrency=1 --network-concurrency=64",
  );
  await ctx.step.exec("format-check", "pnpm format-check");
  await ctx.step.exec("lint", "pnpm lint");
  await ctx.step.exec("typecheck", "pnpm typecheck");
  await ctx.step.exec("fallow", "pnpm fallow");
});
