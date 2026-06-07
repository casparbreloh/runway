import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { runFlow } from "../src/flow/engine.ts";
import type { FlowManifest } from "../src/flow/manifest.ts";
import { linearToPr } from "../src/flows.ts";
import { type ExecResult, Recorder, RecordingSandbox } from "../src/sandbox.ts";
import { inMemoryStore } from "../src/store.ts";
import { happyRun } from "./fixtures.ts";

const recordingHttp = (calls: string[]): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      calls.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 })),
      );
    }),
  );

const creds = inMemoryStore({ credentials: { codex: '{"tok":"SEED"}', linear: "lin_key" } });

describe("flow engine", () => {
  it.effect(
    "linear-to-pr: opens a draft PR, then POSTs the comment-back to Linear via http",
    () => {
      const calls: string[] = [];
      return Effect.gen(function* () {
        yield* runFlow(
          linearToPr,
          {
            sourceType: "linear",
            repo: "acme/widgets",
            plan: "Do it.",
            ref: "ENG-1",
            agent: "codex",
            body: { data: { id: "uuid-1" } },
          },
          { githubToken: "GH" },
        );
        const commands = yield* Ref.get((yield* Recorder).commands);
        expect(commands.some((c) => c.includes("gh pr create --draft"))).toBe(true);
        expect(calls).toContain("https://api.linear.app/graphql");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(RecordingSandbox({ exec: happyRun }), creds, recordingHttp(calls)),
        ),
      );
    },
  );

  it.effect("forEach + shell: lists items and runs the agent once per item", () =>
    Effect.gen(function* () {
      const sweep: FlowManifest = {
        id: "sweep",
        trigger: { cron: "0 0 * * *" },
        repo: "acme/widgets",
        agent: "codex",
        steps: [
          { id: "issues", shell: "gh issue list --json number,title,body" },
          {
            id: "fix",
            forEach: "{{ steps.issues.json }}",
            run: "Fix #{{ item.number }}",
            pr: true,
          },
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
          creds,
          recordingHttp([]),
        ),
      ),
    ),
  );
});
