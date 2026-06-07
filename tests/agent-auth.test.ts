import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import { withAgentAuth } from "../src/agent-auth.ts";
import { agents } from "../src/agents/index.ts";
import { Recorder, RecordingSandbox } from "../src/sandbox.ts";
import { inMemoryStore, Store } from "../src/store.ts";
import { happyRun, piSpec } from "./fixtures.ts";

describe("withAgentAuth", () => {
  it.effect(
    "seeds the subscription credential, never leaks it, and writes back the rotated token",
    () =>
      Effect.gen(function* () {
        yield* withAgentAuth(
          "codex",
          { githubToken: "GH-SECRET" },
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
        expect(env.GITHUB_TOKEN).toBe("GH-SECRET");
        const joined = commands.join("\n");
        expect(joined).not.toContain("SEED");
        expect(joined).not.toContain("ROTATED");
        expect(joined).not.toContain("GH-SECRET");
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
