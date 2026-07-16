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
}).run(async (run) => {
  await run.exec("setup-node", { command: setupCiToolchain, timeoutMs: 15 * 60_000 });
  await run.exec("setup-pnpm", "pnpm --version");
  await run.exec("toolchain", "node --version && pnpm --version");
  await run.exec("install", installCiDependencies);
  await run.exec("test", { command: "pnpm test", env: { VITEST_MAX_WORKERS: "1" } });
});
