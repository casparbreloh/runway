# Agent instructions (Runway)

General guidance for coding agents (pi) running a Runway job inside the sandbox.
The orchestrator loads this file automatically; keep changes scoped to the plan.

## Workflow

- Read `PLAN.md` (written by Runway) — it is the task. Implement exactly what it asks, nothing speculative.
- Make the smallest change that satisfies the plan. Match the repo's existing style.
- After implementing, run the project's validation (tests/lint/build) and fix what your change breaks.

## PR behavior (conservative defaults)

- PRs are always **draft**. Never auto-merge.
- Commit with a clear `<type>(<scope>): <desc>` subject. One focused branch per job.
- If the task cannot be completed, stop and explain why in the final message — do not force a partial commit.

## Skills

- Project-local skills live in `.pi/skills/` and `.agents/skills/`; use them when relevant.
