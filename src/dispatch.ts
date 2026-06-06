import { Effect } from "effect";

import { agents } from "./agents/index.ts";
import { authProviders } from "./auth/index.ts";
import { type JobResult, type JobSpec, jobResult } from "./domain.ts";
import { Sandbox } from "./sandbox.ts";
import { Store } from "./store.ts";

export interface DispatchSecrets {
  readonly githubToken: string;
  readonly openaiApiKey?: string;
}

export const dispatchJob = (
  spec: JobSpec,
  secrets: DispatchSecrets,
): Effect.Effect<JobResult, never, Sandbox | Store> =>
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

    const result = yield* agent.run(spec);

    if (provider.credentialKey !== null) {
      const rotated = yield* provider.collect();
      if (rotated) {
        yield* store
          .putCredential(provider.credentialKey, rotated, credUpdatedAt)
          .pipe(Effect.orElseSucceed(() => undefined));
      }
    }

    yield* store.putJob(result).pipe(Effect.orElseSucceed(() => undefined));
    return result;
  });
