import type { Agent } from "./agent.ts";
import { runGitPr } from "./git-pr.ts";

export const codexAgent: Agent = {
  name: "codex",
  container: "codex",
  run: (spec, opts) =>
    runGitPr(spec, {
      agentCommand: `codex exec --full-auto "Read /work/PLAN.md and follow it. If you change files, write a short PR.md summarizing the change."`,
      ...opts,
    }),
};
