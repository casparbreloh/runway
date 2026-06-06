// Codex Cloud executor: submit a job's plan to Codex Cloud and return the task URL/id.
import { Effect } from "effect";
import type { JobResult, JobSpec } from "../domain.ts";
import { Sandbox } from "../Sandbox.ts";

export const runCodexCloud = (
  spec: JobSpec,
  opts: { envId: string; accessToken?: string },
): Effect.Effect<JobResult, never, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    if (!opts.envId) {
      return {
        jobId: spec.id,
        executor: "codex-cloud",
        status: "failure",
        error: "missing CODEX_CLOUD_ENV_ID",
      };
    }

    if (opts.accessToken) {
      yield* sandbox.setEnvVars({ CODEX_ACCESS_TOKEN: opts.accessToken });
      yield* sandbox.exec("printenv CODEX_ACCESS_TOKEN | codex login --with-access-token");
    }

    yield* sandbox.writeFile("/work/prompt.txt", spec.plan);

    // envId/branch are not secrets.
    const r = yield* sandbox.exec(
      "cat /work/prompt.txt | codex cloud exec --env " + opts.envId + " --branch " + spec.branch + " -",
    );

    if (r.exitCode !== 0) {
      return {
        jobId: spec.id,
        executor: "codex-cloud",
        status: "failure",
        error: "codex cloud exec failed",
        logsTail: r.stderr.slice(-2000),
      };
    }

    const lines = r.stdout.trim().split("\n");
    const taskUrl = lines[lines.length - 1]?.trim() ?? "";
    if (!taskUrl.startsWith("https://chatgpt.com/codex/tasks/")) {
      return {
        jobId: spec.id,
        executor: "codex-cloud",
        status: "failure",
        error: "codex cloud exec produced no task URL",
        logsTail: (r.stdout + r.stderr).slice(-2000),
      };
    }

    const taskId = taskUrl.slice(taskUrl.lastIndexOf("/") + 1);
    return {
      jobId: spec.id,
      executor: "codex-cloud",
      status: "submitted",
      taskUrl,
      taskId,
      summary: "Submitted to Codex Cloud",
    };
  });
