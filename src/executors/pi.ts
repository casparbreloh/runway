import { Effect } from "effect";

import { type JobResult, type JobSpec, jobResult } from "../domain.ts";
import { Sandbox } from "../sandbox.ts";

const REDACT_TOKEN = /x-access-token:[^@\s]+@/g;
const tail = (s: string): string => (s.length > 2000 ? s.slice(-2000) : s);
const redact = (s: string): string => tail(s).replace(REDACT_TOKEN, "x-access-token:***@");

const parseJsonLines = (text: string): any[] =>
  text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

export const runPi = (
  spec: JobSpec,
  opts: { githubToken: string; anthropicApiKey?: string; openaiApiKey?: string; workdir?: string },
): Effect.Effect<JobResult, never, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const repoDir = `${opts.workdir ?? "/work"}/repo`;

    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: "0",
      GITHUB_TOKEN: opts.githubToken,
      RUNWAY_COMMIT_MSG: spec.title ?? `Runway: ${spec.branch}`,
    };
    if (opts.anthropicApiKey !== undefined) env.ANTHROPIC_API_KEY = opts.anthropicApiKey;
    if (opts.openaiApiKey !== undefined) env.OPENAI_API_KEY = opts.openaiApiKey;
    yield* sandbox.setEnvVars(env);

    const clone = yield* sandbox.exec(
      `git clone --depth 1 https://x-access-token:\${GITHUB_TOKEN}@github.com/${spec.repo.owner}/${spec.repo.name}.git ${repoDir}`,
    );
    if (clone.exitCode !== 0) {
      return jobResult(spec, "failure", {
        error: "git clone failed",
        logsTail: redact(clone.stderr),
      });
    }

    yield* sandbox.exec(
      `cd ${repoDir} && git checkout -B ${spec.branch} && git config user.email runway@local && git config user.name Runway`,
    );
    yield* sandbox.writeFile(`${repoDir}/PLAN.md`, spec.plan);

    const pi = yield* sandbox.exec(
      `cd ${repoDir} && pi --mode json -p "Read PLAN.md and implement it. Make the smallest change that satisfies it."`,
    );
    const events = parseJsonLines(pi.stdout);
    const ended = events.some((e) => e?.type === "agent_end");
    const toolErrors = events
      .filter((e) => e?.type === "tool_execution_end" && e.isError)
      .map((e) => e.toolName);
    if (pi.exitCode !== 0 || !ended) {
      const detail = toolErrors.length ? ` (tool errors: ${toolErrors.join(",")})` : "";
      return jobResult(spec, "failure", {
        error: `pi step failed${detail}`,
        logsTail: redact(pi.stderr || pi.stdout),
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
        summary: "pi job completed; no changes produced, nothing to push.",
      });
    }

    const commit = yield* sandbox.exec(`cd ${repoDir} && git commit -m "$RUNWAY_COMMIT_MSG"`);
    if (commit.exitCode !== 0) {
      return jobResult(spec, "failure", {
        error: "git commit failed",
        logsTail: redact(commit.stderr),
      });
    }

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
          ? `pi job completed; validation failed; branch ${spec.branch} pushed.`
          : `pi job completed; branch ${spec.branch} pushed.`,
    });
  });
