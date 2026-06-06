import { Effect } from "effect";

import { Sandbox } from "../sandbox.ts";
import type { AuthProvider } from "./auth-provider.ts";

export const openaiApiKey: AuthProvider = {
  name: "openai-api-key",
  credentialKey: null,
  prepare: (material) =>
    Effect.gen(function* () {
      const s = yield* Sandbox;
      yield* s.setEnvVars({ OPENAI_API_KEY: material });
    }),
  collect: () => Effect.succeed(null),
};
