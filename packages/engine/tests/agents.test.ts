import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import { agents } from "../src/agents/index.ts";
import { RecordingSandbox, SandboxLog } from "../src/sandbox.ts";
import { happyRun, piSpec } from "./fixtures.ts";

describe("agents", () => {
  it.effect("codex runs `codex exec` in the sandbox", () =>
    Effect.gen(function* () {
      yield* agents.codex.run({ ...piSpec, agent: "codex" });
      const commands = yield* Ref.get((yield* SandboxLog).commands);
      expect(commands.some((c) => c.includes("codex exec"))).toBe(true);
    }).pipe(Effect.provide(RecordingSandbox({ exec: happyRun }))),
  );

  it.effect("pi runs on the openai-codex model in the sandbox", () =>
    Effect.gen(function* () {
      yield* agents.pi.run(piSpec);
      const commands = yield* Ref.get((yield* SandboxLog).commands);
      expect(commands.some((c) => c.includes("pi --model openai-codex"))).toBe(true);
    }).pipe(Effect.provide(RecordingSandbox({ exec: happyRun }))),
  );
});
