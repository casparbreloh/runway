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
  authProvider: "pi-subscription",
  run: (spec) =>
    runGitPr(spec, {
      agentCommand: `pi --model openai-codex/gpt-5.5 --mode json -p "Read PLAN.md and implement it. Make the smallest change that satisfies it."`,
      succeeded: piSucceeded,
    }),
};
