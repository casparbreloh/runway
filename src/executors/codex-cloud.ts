import { Effect } from "effect";

import { type JobResult, type JobSpec, jobResult } from "../domain.ts";
import { Sandbox } from "../sandbox.ts";

export const runCodexCloud = (
  spec: JobSpec,
  opts: { envId: string; accessToken?: string },
): Effect.Effect<JobResult, never, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    if (!opts.envId) return jobResult(spec, "failure", { error: "missing CODEX_CLOUD_ENV_ID" });

    if (opts.accessToken) {
      yield* sandbox.setEnvVars({ CODEX_ACCESS_TOKEN: opts.accessToken });
      yield* sandbox.exec("printenv CODEX_ACCESS_TOKEN | codex login --with-access-token");
    }

    yield* sandbox.writeFile("/work/prompt.txt", spec.plan);

    const r = yield* sandbox.exec(
      `cat /work/prompt.txt | codex cloud exec --env ${opts.envId} --branch ${spec.branch} -`,
    );
    if (r.exitCode !== 0) {
      return jobResult(spec, "failure", {
        error: "codex cloud exec failed",
        logsTail: r.stderr.slice(-2000),
      });
    }

    const lines = r.stdout.trim().split("\n");
    const taskUrl = lines[lines.length - 1]?.trim() ?? "";
    if (!taskUrl.startsWith("https://chatgpt.com/codex/tasks/")) {
      return jobResult(spec, "failure", {
        error: "codex cloud exec produced no task URL",
        logsTail: (r.stdout + r.stderr).slice(-2000),
      });
    }

    return jobResult(spec, "submitted", {
      taskUrl,
      taskId: taskUrl.slice(taskUrl.lastIndexOf("/") + 1),
      summary: "Submitted to Codex Cloud",
    });
  });
