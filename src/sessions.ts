import type * as cf from "@cloudflare/workers-types";
import { Context, Effect, Layer } from "effect";

// Best-effort session records — the corpus for later AI analysis of prompts and
// execution loops. Writes never fail a flow.
export interface SessionsService {
  readonly put: (key: string, value: string) => Effect.Effect<void>;
}

export const Sessions = Context.Service<SessionsService>("Sessions");
export type Sessions = (typeof Sessions)["Identifier"];

export const r2Sessions = (bucket: cf.R2Bucket): SessionsService => ({
  put: (key, value) =>
    Effect.tryPromise(() => bucket.put(key, value)).pipe(
      Effect.asVoid,
      Effect.orElseSucceed(() => undefined),
    ),
});

export const noopSessions: Layer.Layer<Sessions> = Layer.succeed(Sessions, {
  put: () => Effect.void,
});
