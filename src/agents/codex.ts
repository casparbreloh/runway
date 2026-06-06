import type { Agent } from "./agent.ts";
import { runGitPr } from "./git-pr.ts";

export const codexAgent: Agent = {
  name: "codex",
  container: "codex",
  authProvider: "codex-subscription",
  run: (spec) =>
    runGitPr(spec, {
      agentCommand: `codex exec --full-auto "Read PLAN.md and implement it. Make the smallest change that satisfies it."`,
    }),
};
