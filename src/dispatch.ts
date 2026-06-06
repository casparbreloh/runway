import { Effect } from "effect";

import { agents } from "./agents/index.ts";
import { authProviders } from "./auth/index.ts";
import { type JobResult, type JobSpec, jobResult } from "./domain.ts";
import { GitHub } from "./github.ts";
import { Sandbox } from "./sandbox.ts";
import { Store } from "./store.ts";

export interface DispatchSecrets {
  readonly githubToken: string;
  readonly openaiApiKey?: string;
}

const prBody = (spec: JobSpec, result: JobResult): string =>
  [
    `Automated draft PR by Runway (agent: ${spec.agent}).`,
    result.validated === undefined ? "" : `Validation: ${result.validated ? "passed" : "failed"}`,
  ]
    .filter(Boolean)
    .join("\n\n");

export const dispatchJob = (
  spec: JobSpec,
  secrets: DispatchSecrets,
): Effect.Effect<JobResult, never, Sandbox | Store | GitHub> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const store = yield* Store;
    const agent = agents[spec.agent];
    const provider = authProviders[agent.authProvider];
    if (!provider)
      return jobResult(spec, "failure", { error: `unknown auth provider "${agent.authProvider}"` });

    yield* sandbox.setEnvVars({ GITHUB_TOKEN: secrets.githubToken });

    let credUpdatedAt: string | undefined;
    if (provider.credentialKey !== null) {
      const cred = yield* store
        .getCredential(provider.credentialKey)
        .pipe(Effect.orElseSucceed(() => null));
      if (!cred)
        return jobResult(spec, "failure", {
          error: `no stored credential for "${provider.credentialKey}"`,
        });
      credUpdatedAt = cred.updatedAt;
      yield* provider.prepare(cred.content);
    } else if (secrets.openaiApiKey !== undefined) {
      yield* provider.prepare(secrets.openaiApiKey);
    } else {
      return jobResult(spec, "failure", { error: "no OPENAI_API_KEY for api-key provider" });
    }

    let result = yield* agent.run(spec);

    if (provider.credentialKey !== null) {
      const rotated = yield* provider.collect();
      if (rotated) {
        yield* store
          .putCredential(provider.credentialKey, rotated, credUpdatedAt)
          .pipe(Effect.orElseSucceed(() => undefined));
      }
    }

    if (result.status === "success" && result.pushed === true) {
      const github = yield* GitHub;
      const outcome = yield* github
        .createOrUpdateDraftPR({
          head: spec.branch,
          base: spec.base,
          title: spec.title ?? `Runway: ${spec.branch}`,
          body: prBody(spec, result),
        })
        .pipe(
          Effect.map((pr) => ({ ok: true as const, pr })),
          Effect.catchTag("GitHubError", (e) =>
            Effect.succeed({ ok: false as const, message: e.message }),
          ),
        );
      if (outcome.ok) {
        yield* github
          .postComment(outcome.pr.number, result.summary ?? `job ${spec.id}: ${result.status}`)
          .pipe(Effect.catchTag("GitHubError", () => Effect.void));
        result = {
          ...result,
          prUrl: outcome.pr.html_url,
          prNumber: outcome.pr.number,
          summary: `Draft PR #${outcome.pr.number} ready: ${outcome.pr.html_url}`,
        };
      } else {
        result = {
          ...result,
          error: `branch ${spec.branch} pushed but PR creation failed: ${outcome.message}`,
          summary: `Branch ${spec.branch} pushed; draft PR creation failed.`,
        };
      }
    }

    yield* store.putJob(result).pipe(Effect.orElseSucceed(() => undefined));
    return result;
  });
