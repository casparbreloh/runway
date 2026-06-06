// Pi executor: clone -> checkout -> write PLAN.md -> run Pi (0.78.1, json mode) -> validate -> commit/push.
// Secrets and the commit message stay OUT of literal command strings; they go through setEnvVars and
// are referenced as ${VAR}, with the shell expanding them at exec time.
import { Effect } from "effect";
import type { JobResult, JobSpec } from "../domain.ts";
import { Sandbox } from "../Sandbox.ts";

const tail = (s: string): string => (s.length > 2000 ? s.slice(-2000) : s);
const redact = (s: string): string => s.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@");

export const runPi = (
  spec: JobSpec,
  opts: { githubToken: string; anthropicApiKey?: string; openaiApiKey?: string; workdir?: string },
): Effect.Effect<JobResult, never, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const workdir = opts.workdir ?? "/work";
    const repoDir = workdir + "/repo";

    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: "0",
      GITHUB_TOKEN: opts.githubToken,
      RUNWAY_COMMIT_MSG: spec.title ?? "Runway: " + spec.branch,
    };
    if (opts.anthropicApiKey !== undefined) env.ANTHROPIC_API_KEY = opts.anthropicApiKey;
    if (opts.openaiApiKey !== undefined) env.OPENAI_API_KEY = opts.openaiApiKey;
    yield* sandbox.setEnvVars(env);

    const clone = yield* sandbox.exec(
      "git clone --depth 1 https://x-access-token:${GITHUB_TOKEN}@github.com/" +
        spec.repo.owner +
        "/" +
        spec.repo.name +
        ".git " +
        repoDir,
    );
    if (clone.exitCode !== 0) {
      return {
        jobId: spec.id,
        executor: "pi",
        status: "failure",
        error: "git clone failed",
        logsTail: redact(tail(clone.stderr)),
      };
    }

    yield* sandbox.exec(
      "cd " +
        repoDir +
        " && git checkout -B " +
        spec.branch +
        " && git config user.email runway@local && git config user.name Runway",
    );

    yield* sandbox.writeFile(repoDir + "/PLAN.md", spec.plan);

    const pi = yield* sandbox.exec(
      "cd " +
        repoDir +
        ' && pi --mode json -p "Read PLAN.md and implement it. Make the smallest change that satisfies it."',
    );
    const events = pi.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const ended = events.some((e) => e && e.type === "agent_end");
    const toolErrors = events
      .filter((e) => e && e.type === "tool_execution_end" && e.isError)
      .map((e) => e.toolName);
    if (pi.exitCode !== 0 || !ended) {
      return {
        jobId: spec.id,
        executor: "pi",
        status: "failure",
        error: "pi step failed" + (toolErrors.length ? " (tool errors: " + toolErrors.join(",") + ")" : ""),
        logsTail: redact(tail(pi.stderr || pi.stdout)),
      };
    }

    let validated: boolean | undefined;
    for (const cmd of spec.validate ?? []) {
      const v = yield* sandbox.exec("cd " + repoDir + " && " + cmd);
      validated = (validated ?? true) && v.exitCode === 0;
    }

    yield* sandbox.exec("cd " + repoDir + " && git add -A");
    const staged = yield* sandbox.exec("cd " + repoDir + " && git diff --cached --quiet");
    if (staged.exitCode === 0) {
      return {
        jobId: spec.id,
        executor: "pi",
        status: "success",
        pushed: false,
        ...(validated !== undefined ? { validated } : {}),
        summary: "pi job completed; no changes produced, nothing to push.",
      };
    }

    const commit = yield* sandbox.exec("cd " + repoDir + ' && git commit -m "$RUNWAY_COMMIT_MSG"');
    if (commit.exitCode !== 0) {
      return {
        jobId: spec.id,
        executor: "pi",
        status: "failure",
        error: "git commit failed",
        logsTail: redact(tail(commit.stderr)),
      };
    }

    const push = yield* sandbox.exec("cd " + repoDir + " && git push -u origin " + spec.branch);
    if (push.exitCode !== 0) {
      return {
        jobId: spec.id,
        executor: "pi",
        status: "failure",
        pushed: false,
        error: "git push failed",
        logsTail: redact(tail(push.stderr)),
      };
    }

    return {
      jobId: spec.id,
      executor: "pi",
      status: "success",
      pushed: true,
      ...(validated !== undefined ? { validated } : {}),
      summary:
        validated === false
          ? "pi job completed; validation failed; branch " + spec.branch + " pushed."
          : "pi job completed; branch " + spec.branch + " pushed.",
    };
  });
