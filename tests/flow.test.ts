import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import { runFlow } from "../src/flow/engine.ts";
import type { FlowManifest } from "../src/flow/manifest.ts";
import { linearToPr } from "../src/flows.ts";
import { type ExecResult, Recorder, RecordingSandbox } from "../src/sandbox.ts";
import { inMemoryStore } from "../src/store.ts";
import { happyRun } from "./fixtures.ts";

const codexCreds = inMemoryStore({ credentials: { codex: '{"tok":"SEED"}' } });

describe("flow engine", () => {
  it.effect("linear-to-pr: the agent opens a draft PR and the result carries the PR url", () =>
    Effect.gen(function* () {
      const result = yield* runFlow(
        linearToPr,
        {
          sourceType: "linear",
          repo: "acme/widgets",
          plan: "Do the thing.",
          title: "Add hello",
          ref: "ENG-123",
          agent: "codex",
        },
        { githubToken: "GH" },
      );
      const commands = yield* Ref.get((yield* Recorder).commands);

      expect(result?.status).toBe("success");
      expect(result?.prUrl).toBe("https://github.com/acme/widgets/pull/7");
      expect(commands.some((c) => c.includes("gh pr create --draft"))).toBe(true);
    }).pipe(Effect.provide(Layer.mergeAll(RecordingSandbox({ exec: happyRun }), codexCreds))),
  );

  it.effect("forEach + shell: lists items and runs the agent once per item", () =>
    Effect.gen(function* () {
      const sweep: FlowManifest = {
        id: "sweep",
        trigger: { cron: "0 0 * * *" },
        repo: "acme/widgets",
        agent: "codex",
        steps: [
          { shell: "gh issue list --json number,title,body", as: "issues" },
          { forEach: "{{ issues }}", run: "Fix #{{ item.number }} {{ item.title }}", pr: true },
        ],
      };
      yield* runFlow(sweep, {}, { githubToken: "GH" });
      const commands = yield* Ref.get((yield* Recorder).commands);

      expect(commands.filter((c) => c.includes("gh pr create")).length).toBe(2);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          RecordingSandbox({
            exec: (command): Partial<ExecResult> =>
              command.includes("gh issue list")
                ? {
                    stdout: JSON.stringify([
                      { number: 1, title: "A", body: "x" },
                      { number: 2, title: "B", body: "y" },
                    ]),
                  }
                : happyRun(command),
          }),
          codexCreds,
        ),
      ),
    ),
  );
});
