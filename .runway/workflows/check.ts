import { github, workflow } from "runway";

import { prepareRepository, repositoryCommand } from "../repository.ts";

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
}).run(async (run) => {
  await prepareRepository(run);
  await run.exec("format-check", repositoryCommand("pnpm format-check"));
  await run.exec("lint", repositoryCommand("pnpm lint"));
  await run.exec("typecheck", repositoryCommand("pnpm typecheck"));
  await run.exec("fallow", repositoryCommand("pnpm fallow"));
});
