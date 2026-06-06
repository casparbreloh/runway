import { Effect } from "effect";

import { type JobResult, type JobSpec, jobResult } from "../domain.ts";
import { Sandbox } from "../sandbox.ts";

const WORKDIR = "/work";
const REPO_DIR = `${WORKDIR}/repo`;
const PLAN_PATH = `${WORKDIR}/PLAN.md`;
const PR_BODY_PATH = `${WORKDIR}/pr-body.md`;
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;
const REDACT_TOKEN = /x-access-token:[^@\s]+@/g;

const tail = (s: string): string => (s.length > 2000 ? s.slice(-2000) : s);
const redact = (s: string): string => tail(s).replace(REDACT_TOKEN, "x-access-token:***@");

export interface GitPrOptions {
  readonly agentCommand: string;
  readonly succeeded?: (stdout: string) => boolean;
}

export const runGitPr = (
  spec: JobSpec,
  opts: GitPrOptions,
): Effect.Effect<JobResult, never, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    if (!SAFE_REF.test(spec.branch) || !SAFE_REF.test(spec.base)) {
      return jobResult(spec, "failure", { error: "invalid branch or base ref" });
    }

    yield* sandbox.setEnvVars({
      GIT_TERMINAL_PROMPT: "0",
      RUNWAY_COMMIT_MSG: spec.title ?? `Runway: ${spec.branch}`,
      RUNWAY_PR_TITLE: spec.title ?? `Runway: ${spec.branch}`,
    });

    const clone = yield* sandbox.exec(
      `git clone --depth 1 --branch ${spec.base} https://x-access-token:\${GITHUB_TOKEN}@github.com/${spec.repo.owner}/${spec.repo.name}.git ${REPO_DIR}`,
    );
    if (clone.exitCode !== 0)
      return jobResult(spec, "failure", {
        error: "git clone failed",
        logsTail: redact(clone.stderr),
      });

    yield* sandbox.exec(
      `cd ${REPO_DIR} && git checkout -B ${spec.branch} && git config user.email runway@local && git config user.name Runway`,
    );
    yield* sandbox.writeFile(PLAN_PATH, spec.plan);

    const run = yield* sandbox.exec(`cd ${REPO_DIR} && ${opts.agentCommand}`);
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
      const v = yield* sandbox.exec(`cd ${REPO_DIR} && ${cmd}`);
      if (v.exitCode !== 0) validated = false;
    }
    const validatedField = validated === undefined ? {} : { validated };

    const agentBody = (yield* sandbox.readFile(`${REPO_DIR}/PR.md`)).trim();
    yield* sandbox.exec(`cd ${REPO_DIR} && rm -f PR.md && git add -A`);
    const staged = yield* sandbox.exec(`cd ${REPO_DIR} && git diff --cached --quiet`);
    if (staged.exitCode === 0) {
      return jobResult(spec, "success", {
        pushed: false,
        ...validatedField,
        summary: "agent completed; no changes produced, nothing to push.",
      });
    }

    const commit = yield* sandbox.exec(`cd ${REPO_DIR} && git commit -m "$RUNWAY_COMMIT_MSG"`);
    if (commit.exitCode !== 0)
      return jobResult(spec, "failure", {
        error: "git commit failed",
        logsTail: redact(commit.stderr),
      });

    const push = yield* sandbox.exec(`cd ${REPO_DIR} && git push -u origin ${spec.branch}`);
    if (push.exitCode !== 0) {
      return jobResult(spec, "failure", {
        pushed: false,
        ...validatedField,
        error: "git push failed",
        logsTail: redact(push.stderr),
      });
    }

    yield* sandbox.writeFile(
      PR_BODY_PATH,
      agentBody || `Automated draft PR by Runway.\n\n## Plan\n\n${spec.plan}`,
    );
    const pr = yield* sandbox.exec(
      `cd ${REPO_DIR} && gh pr create --draft --base ${spec.base} --head ${spec.branch} --title "$RUNWAY_PR_TITLE" --body-file ${PR_BODY_PATH} || gh pr view ${spec.branch} --json url --jq .url`,
    );
    const prUrl = pr.stdout.trim().split("\n").filter(Boolean).pop()?.trim();
    if (!prUrl || !prUrl.startsWith("https://")) {
      return jobResult(spec, "success", {
        pushed: true,
        ...validatedField,
        summary: `branch ${spec.branch} pushed; draft PR creation failed — open it manually.`,
      });
    }
    const prNumber = Number.parseInt(prUrl.split("/").pop() ?? "", 10);
    return jobResult(spec, "success", {
      pushed: true,
      prUrl,
      ...(Number.isInteger(prNumber) ? { prNumber } : {}),
      ...validatedField,
      summary:
        validated === false
          ? `validation failed; draft PR ready: ${prUrl}`
          : `draft PR ready: ${prUrl}`,
    });
  });
