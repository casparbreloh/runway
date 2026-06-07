import type { Agent } from "./agent.ts";
import { runGitPr } from "./git-pr.ts";

const piSucceeded = (stdout: string): boolean =>
  stdout.split("\n").some((line) => {
    try {
      return (JSON.parse(line) as { type?: string }).type === "agent_end";
    } catch {
      return false;
    }
  });

export const piAgent: Agent = {
  name: "pi",
  container: "pi",
  run: (spec, opts) =>
    runGitPr(spec, {
      agentCommand: `pi --model openai-codex/gpt-5.5 --mode json -p "Read /work/PLAN.md and follow it. If you change files, write a short PR.md summarizing the change."`,
      succeeded: piSucceeded,
      ...opts,
    }),
};
