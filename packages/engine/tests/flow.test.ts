import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { runWorkflow } from "../src/interpreter.ts";
import { isRun, isShell, type WorkflowManifest } from "../src/manifest.ts";
import { workflow } from "../src/recorder.ts";
import { type ExecResult, RecordingSandbox, SandboxLog } from "../src/sandbox.ts";
import { noopSessions } from "../src/sessions.ts";
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

const creds = inMemoryStore({
  credentials: {
    codex: JSON.stringify({
      access: "A",
      refresh: "R",
      expires: 9999999999999,
      accountId: "acc",
    }),
    linear: "lin_key",
  },
});

// The recorder DSL equivalent of the linear-to-pr flow, built fluently. Running the
// builder once must yield a declarative Step[] the interpreter executes unchanged.
const linearToPr = workflow(
  "linear-to-pr",
  (s) => {
    s.run({
      prompt: "{{ body.data.title }}",
      pr: true,
      branch: "runway/{{ body.data.identifier }}",
    });
    s.http({
      url: "https://api.linear.app/graphql",
      method: "POST",
      headers: { authorization: "{{ secrets.linear }}", "content-type": "application/json" },
      json: { id: "{{ body.data.id }}" },
    });
  },
  { repo: "acme/widgets", agent: "codex" },
);

describe("recorder", () => {
  it("compiles fluent calls into the Schema-shaped Step[]", () => {
    const wf = workflow(
      "demo",
      (s) => {
        const issues = s.shell("gh issue list --json number", { as: "issues" });
        s.run({ prompt: "Fix {{ item.number }}", forEach: issues.ref("json"), pr: true });
      },
      { repo: "acme/widgets" },
    );

    expect(wf).toEqual({
      id: "demo",
      repo: "acme/widgets",
      steps: [
        { id: "issues", shell: "gh issue list --json number" },
        {
          id: "step1",
          run: "Fix {{ item.number }}",
          pr: true,
          forEach: "{{ steps.issues.json }}",
        },
      ],
    });
    expect(wf.steps[0]).toSatisfy(isShell);
    expect(wf.steps[1]).toSatisfy(isRun);
  });
});

describe("flow engine", () => {
  it.effect(
    "linear-to-pr: opens a draft PR, then POSTs the comment-back to Linear via http",
    () => {
      const calls: string[] = [];
      return Effect.gen(function* () {
        yield* runWorkflow(linearToPr, {
          body: {
            data: { id: "uuid-1", title: "Add hello", description: "Do it.", identifier: "ENG-1" },
          },
        });
        const commands = yield* Ref.get((yield* SandboxLog).commands);
        expect(commands.some((c) => c.includes("gh pr create --draft"))).toBe(true);
        expect(calls).toContain("https://api.linear.app/graphql");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RecordingSandbox({ exec: happyRun }),
            creds,
            recordingHttp(calls),
            noopSessions,
          ),
        ),
      );
    },
  );

  it.effect("forEach + shell: lists items and runs the agent once per item", () =>
    Effect.gen(function* () {
      const sweep: WorkflowManifest = {
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
      yield* runWorkflow(sweep, {});
      const commands = yield* Ref.get((yield* SandboxLog).commands);
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
          noopSessions,
        ),
      ),
    ),
  );
});
