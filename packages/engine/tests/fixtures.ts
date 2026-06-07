import type { JobSpec } from "../src/domain.ts";
import type { ExecResult } from "../src/sandbox.ts";

export const piSpec: JobSpec = {
  id: "job-1",
  repo: { owner: "acme", name: "widgets" },
  branch: "runway/feature",
  plan: "Add a hello function.",
  agent: "pi",
  base: "main",
  validate: ["pnpm test"],
  title: "feat: add hello",
};

// Sandbox responder: changes staged, the pi JSON stream ends with agent_end, gh prints the PR url.
export const happyRun = (command: string): Partial<ExecResult> => {
  if (command.includes("git diff --cached --quiet")) return { exitCode: 1 };
  if (command.includes("--mode json")) return { stdout: '{"type":"agent_end"}\n' };
  if (command.includes("gh pr create"))
    return { stdout: "https://github.com/acme/widgets/pull/7\n" };
  return {};
};
