import { Effect } from "effect";

import { Store } from "../store.ts";

// Secret auth: flat, named static values held in the vault — API keys, tokens,
// webhook secrets. A provider can have several (`github`, `github_webhook`, ...);
// they are just names. Static — never refreshed, unlike a subscription.
export const loadSecrets = (
  names: readonly string[],
): Effect.Effect<Record<string, string>, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const out: Record<string, string> = {};
    for (const name of names) {
      const cred = yield* store.getCredential(name).pipe(Effect.orElseSucceed(() => null));
      if (cred) out[name] = cred.content;
    }
    return out;
  });
