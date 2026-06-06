import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import { dispatchJob } from "../src/dispatch.ts";
import { Recorder, RecordingSandbox } from "../src/sandbox.ts";
import { inMemoryStore, Store } from "../src/store.ts";
import { happyRun, piSpec } from "./fixtures.ts";

describe("dispatch", () => {
  it.effect(
    "seeds the subscription credential, never leaks it, and writes back the rotated token",
    () =>
      Effect.gen(function* () {
        yield* dispatchJob({ ...piSpec, agent: "codex" }, { githubToken: "GH-SECRET" });
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

  it.effect("runs a pi job and opens a draft PR in the sandbox via gh", () =>
    Effect.gen(function* () {
      const result = yield* dispatchJob(piSpec, { githubToken: "GH-SECRET" });
      const commands = yield* Ref.get((yield* Recorder).commands);

      expect(result.status).toBe("success");
      expect(result.pushed).toBe(true);
      expect(result.prUrl).toBe("https://github.com/acme/widgets/pull/7");
      expect(result.prNumber).toBe(7);
      expect(
        commands.some((c) => c.includes("gh pr create --draft") && c.includes("runway/feature")),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          RecordingSandbox({ exec: happyRun }),
          inMemoryStore({ credentials: { pi: '{"tok":"SEED"}' } }),
        ),
      ),
    ),
  );
});
