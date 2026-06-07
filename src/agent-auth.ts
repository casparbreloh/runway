import { Effect } from "effect";

import { agents } from "./agents/index.ts";
import { authProviders } from "./auth/index.ts";
import { AuthError, type AgentName } from "./domain.ts";
import { Sandbox } from "./sandbox.ts";
import { Store } from "./store.ts";

export interface AgentSecrets {
  readonly githubToken: string;
  readonly openaiApiKey?: string;
}

export const withAgentAuth = <A, E, R>(
  agentName: AgentName,
  secrets: AgentSecrets,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AuthError, R | Sandbox | Store> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const store = yield* Store;
    const provider = authProviders[agents[agentName].authProvider];
    if (!provider)
      return yield* Effect.fail(
        new AuthError({ reason: `unknown auth provider for agent "${agentName}"` }),
      );

    yield* sandbox.setEnvVars({ GITHUB_TOKEN: secrets.githubToken });

    let credUpdatedAt: string | undefined;
    if (provider.credentialKey !== null) {
      const cred = yield* store
        .getCredential(provider.credentialKey)
        .pipe(Effect.orElseSucceed(() => null));
      if (!cred)
        return yield* Effect.fail(
          new AuthError({ reason: `no stored credential for "${provider.credentialKey}"` }),
        );
      credUpdatedAt = cred.updatedAt;
      yield* provider.prepare(cred.content);
    } else if (secrets.openaiApiKey !== undefined) {
      yield* provider.prepare(secrets.openaiApiKey);
    } else {
      return yield* Effect.fail(
        new AuthError({ reason: "no OPENAI_API_KEY for api-key provider" }),
      );
    }

    const out = yield* body;

    if (provider.credentialKey !== null) {
      const rotated = yield* provider.collect();
      if (rotated)
        yield* store
          .putCredential(provider.credentialKey, rotated, credUpdatedAt)
          .pipe(Effect.orElseSucceed(() => undefined));
    }
    return out;
  });
