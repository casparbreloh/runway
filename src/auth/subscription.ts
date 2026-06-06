import { Effect } from "effect";

import { Sandbox } from "../sandbox.ts";
import type { AuthProvider } from "./auth-provider.ts";

export const subscriptionProvider = (cfg: {
  name: string;
  credentialKey: string;
  configDirEnv: string;
  configDir: string;
  authPath: string;
}): AuthProvider => ({
  name: cfg.name,
  credentialKey: cfg.credentialKey,
  prepare: (material) =>
    Effect.gen(function* () {
      const s = yield* Sandbox;
      yield* s.setEnvVars({ [cfg.configDirEnv]: cfg.configDir });
      yield* s.writeFile(cfg.authPath, material);
    }),
  collect: () =>
    Effect.gen(function* () {
      const s = yield* Sandbox;
      return yield* s.readFile(cfg.authPath);
    }),
});
