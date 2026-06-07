import { Effect } from "effect";

import { type AgentName, AuthError } from "../domain.ts";
import { Sandbox } from "../sandbox.ts";
import { Store } from "../store.ts";

// A subscription is rendered into the auth file an agent's CLI reads. Adding one is
// a config row here, not a new file — the handler below is fully generic.
export interface SubConfig {
  readonly env: string; // config-dir env var, e.g. CODEX_HOME
  readonly dir: string; // config-dir value, e.g. /work/.codex
  readonly path: string; // auth-file path the CLI reads
}

export const subs: Record<AgentName, SubConfig> = {
  codex: { env: "CODEX_HOME", dir: "/work/.codex", path: "/work/.codex/auth.json" },
  pi: { env: "PI_CODING_AGENT_DIR", dir: "/work/.pi-agent", path: "/work/.pi-agent/auth.json" },
};

// Subscription auth (the OAuth half): writes the stored credential into the sandbox,
// runs `body`, then writes back the rotated token under optimistic concurrency.
// `apiKey` is the static-secret fallback (sets OPENAI_API_KEY). The other half is
// static secrets — see ./secrets.ts.
export const withSubscription = <A, E, R>(
  agentName: AgentName,
  apiKey: string | undefined,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AuthError, R | Sandbox | Store> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const store = yield* Store;
    const sub = subs[agentName];

    const cred = yield* store.getCredential(agentName).pipe(Effect.orElseSucceed(() => null));
    if (cred) {
      yield* sandbox.setEnvVars({ [sub.env]: sub.dir });
      yield* sandbox.writeFile(sub.path, cred.content);
    } else if (apiKey !== undefined && apiKey !== "") {
      yield* sandbox.setEnvVars({ OPENAI_API_KEY: apiKey });
    } else {
      return yield* Effect.fail(
        new AuthError({ reason: `no subscription or api key for agent "${agentName}"` }),
      );
    }

    const out = yield* body;

    if (cred) {
      const rotated = yield* sandbox.readFile(sub.path).pipe(Effect.orElseSucceed(() => ""));
      if (rotated && rotated !== cred.content)
        yield* store
          .putCredential(agentName, rotated, cred.updatedAt)
          .pipe(Effect.orElseSucceed(() => undefined));
    }
    return out;
  });
