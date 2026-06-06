import type { Effect } from "effect";

import type { Sandbox } from "../sandbox.ts";

export interface AuthProvider {
  readonly name: string;
  readonly credentialKey: string | null;
  readonly prepare: (material: string) => Effect.Effect<void, never, Sandbox>;
  readonly collect: () => Effect.Effect<string | null, never, Sandbox>;
}
