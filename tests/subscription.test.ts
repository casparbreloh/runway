import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import { agents } from "../src/agents/index.ts";
import { withSubscription } from "../src/auth/index.ts";
import { Recorder, RecordingSandbox } from "../src/sandbox.ts";
import { inMemoryStore, Store } from "../src/store.ts";
import { happyRun, piSpec } from "./fixtures.ts";

describe("withSubscription", () => {
  it.effect(
    "prepares the subscription credential, never leaks it, and writes back the rotated token",
    () =>
      Effect.gen(function* () {
        yield* withSubscription(
          "codex",
          undefined,
          agents.codex.run({ ...piSpec, agent: "codex" }),
        ).pipe(Effect.orDie);

        const writes = yield* Ref.get((yield* Recorder).writes);
        const env = yield* Ref.get((yield* Recorder).envVars);
        const commands = yield* Ref.get((yield* Recorder).commands);
        const stored = yield* (yield* Store).getCredential("codex");

        expect(writes).toContainEqual({
          path: "/work/.codex/auth.json",
          content: '{"tok":"SEED"}',
        });
        expect(env.CODEX_HOME).toBe("/work/.codex");
        const joined = commands.join("\n");
        expect(joined).not.toContain("SEED");
        expect(joined).not.toContain("ROTATED");
        expect(stored?.content).toBe('{"tok":"ROTATED"}');
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RecordingSandbox({
              exec: happyRun,
              read: (path) => (path === "/work/.codex/auth.json" ? '{"tok":"ROTATED"}' : undefined),
            }),
            inMemoryStore({ credentials: { codex: '{"tok":"SEED"}' } }),
          ),
        ),
      ),
  );
});
