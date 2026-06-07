import { Effect } from "effect";

import { agents } from "../agents/index.ts";
import { type AgentName, AuthError } from "../domain.ts";
import { Sandbox } from "../sandbox.ts";
import { Store } from "../store.ts";
import type { AuthProvider } from "./auth-provider.ts";
import { codexSubscription } from "./codex-subscription.ts";
import { openaiApiKey } from "./openai-api-key.ts";
import { piSubscription } from "./pi-subscription.ts";

export const subscriptions: Record<string, AuthProvider> = {
  "codex-subscription": codexSubscription,
  "pi-subscription": piSubscription,
  "openai-api-key": openaiApiKey,
};

// Subscription auth: prepares the agent's rotating OAuth credential into the
// sandbox, runs `body`, then writes back the rotated refresh token under optimistic
// concurrency. `apiKey` is the static-secret fallback for the no-subscription path.
// The other half of auth is static secrets — see ./secrets.ts.
export const withSubscription = <A, E, R>(
  agentName: AgentName,
  apiKey: string | undefined,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AuthError, R | Sandbox | Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const provider = subscriptions[agents[agentName].authProvider];
    if (!provider)
      return yield* Effect.fail(
        new AuthError({ reason: `unknown subscription provider for agent "${agentName}"` }),
      );

    let credUpdatedAt: string | undefined;
    if (provider.credentialKey !== null) {
      const cred = yield* store
        .getCredential(provider.credentialKey)
        .pipe(Effect.orElseSucceed(() => null));
      if (!cred)
        return yield* Effect.fail(
          new AuthError({ reason: `no subscription credential "${provider.credentialKey}"` }),
        );
      credUpdatedAt = cred.updatedAt;
      yield* provider.prepare(cred.content);
    } else if (apiKey !== undefined && apiKey !== "") {
      yield* provider.prepare(apiKey);
    } else {
      return yield* Effect.fail(
        new AuthError({ reason: `no subscription or api key for agent "${agentName}"` }),
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

export type { AuthProvider } from "./auth-provider.ts";
