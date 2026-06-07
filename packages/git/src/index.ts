import type { Recorder, StepRef } from "@runway/engine";

// Typed git step-builder. `git.pr(s, {...})` records a single run Step (pr: true) the
// interpreter routes through its built-in clone -> agent -> commit -> push -> draft-PR
// pipeline (packages/engine/src/agents/git-pr.ts). That pipeline is the ONE source of
// truth for git: it shell-escapes via env vars (RUNWAY_COMMIT_MSG/RUNWAY_PR_TITLE),
// cleans up PR.md before staging, and falls back to `gh pr view` — so this helper
// inherits all of it instead of re-implementing a second, lower-fidelity copy.
export interface PrArgs {
  // What the agent should do; baked into /work/PLAN.md as the run prompt.
  readonly prompt: string;
  // Branch to push, e.g. "runway/{{ body.data.identifier }}". Resolved at runtime.
  readonly branch: string;
  readonly id?: string;
  readonly when?: string;
  readonly forEach?: string;
}

export const pr = (s: Recorder, args: PrArgs): StepRef =>
  s.run({
    prompt: args.prompt,
    pr: true,
    branch: args.branch,
    ...(args.id !== undefined ? { id: args.id } : {}),
    ...(args.when !== undefined ? { when: args.when } : {}),
    ...(args.forEach !== undefined ? { forEach: args.forEach } : {}),
  });
