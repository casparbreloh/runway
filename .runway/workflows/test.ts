import { github, workflow } from "runway";

import { finishRepository, prepareRepository, repositoryCommand } from "../repository.ts";

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
  await prepareRepository(run);
  await run.exec("test", repositoryCommand("pnpm test", { env: { VITEST_MAX_WORKERS: "1" } }));
  await finishRepository(run);
});
