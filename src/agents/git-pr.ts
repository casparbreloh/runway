import { Effect } from "effect";

import { type JobResult, type JobSpec, jobResult } from "../domain.ts";
import { Sandbox } from "../sandbox.ts";

const REDACT_TOKEN = /x-access-token:[^@\s]+@/g;
const tail = (s: string): string => (s.length > 2000 ? s.slice(-2000) : s);
const redact = (s: string): string => tail(s).replace(REDACT_TOKEN, "x-access-token:***@");

export interface GitPrOptions {
  readonly agentCommand: string;
  readonly succeeded?: (stdout: string) => boolean;
  readonly workdir?: string;
}

export const runGitPr = (
  spec: JobSpec,
  opts: GitPrOptions,
): Effect.Effect<JobResult, never, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const repoDir = `${opts.workdir ?? "/work"}/repo`;

    yield* sandbox.setEnvVars({
      GIT_TERMINAL_PROMPT: "0",
      RUNWAY_COMMIT_MSG: spec.title ?? `Runway: ${spec.branch}`,
    });

    const clone = yield* sandbox.exec(
      `git clone --depth 1 https://x-access-token:\${GITHUB_TOKEN}@github.com/${spec.repo.owner}/${spec.repo.name}.git ${repoDir}`,
    );
    if (clone.exitCode !== 0)
      return jobResult(spec, "failure", {
        error: "git clone failed",
        logsTail: redact(clone.stderr),
      });

    yield* sandbox.exec(
      `cd ${repoDir} && git checkout -B ${spec.branch} && git config user.email runway@local && git config user.name Runway`,
    );
    yield* sandbox.writeFile(`${repoDir}/PLAN.md`, spec.plan);

    const run = yield* sandbox.exec(`cd ${repoDir} && ${opts.agentCommand}`);
    const ok = opts.succeeded ? opts.succeeded(run.stdout) : run.exitCode === 0;
    if (run.exitCode !== 0 || !ok) {
      return jobResult(spec, "failure", {
        error: "agent step failed",
        logsTail: redact(run.stderr || run.stdout),
      });
    }

    const cmds = spec.validate ?? [];
    let validated: boolean | undefined = cmds.length > 0 ? true : undefined;
    for (const cmd of cmds) {
      const v = yield* sandbox.exec(`cd ${repoDir} && ${cmd}`);
      if (v.exitCode !== 0) validated = false;
    }

    yield* sandbox.exec(`cd ${repoDir} && git add -A`);
    const staged = yield* sandbox.exec(`cd ${repoDir} && git diff --cached --quiet`);
    if (staged.exitCode === 0) {
      return jobResult(spec, "success", {
        pushed: false,
        ...(validated !== undefined ? { validated } : {}),
        summary: "agent completed; no changes produced, nothing to push.",
      });
    }

    const commit = yield* sandbox.exec(`cd ${repoDir} && git commit -m "$RUNWAY_COMMIT_MSG"`);
    if (commit.exitCode !== 0)
      return jobResult(spec, "failure", {
        error: "git commit failed",
        logsTail: redact(commit.stderr),
      });

    const push = yield* sandbox.exec(`cd ${repoDir} && git push -u origin ${spec.branch}`);
    if (push.exitCode !== 0) {
      return jobResult(spec, "failure", {
        pushed: false,
        error: "git push failed",
        logsTail: redact(push.stderr),
      });
    }

    return jobResult(spec, "success", {
      pushed: true,
      ...(validated !== undefined ? { validated } : {}),
      summary:
        validated === false
          ? `agent completed; validation failed; branch ${spec.branch} pushed.`
          : `agent completed; branch ${spec.branch} pushed.`,
    });
  });
