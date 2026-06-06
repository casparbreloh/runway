import { createHmac } from "node:crypto";

import { Effect, Layer, Ref } from "effect";
import { describe, expect, it } from "vitest";

import { agents } from "../src/agents/index.ts";
import { dispatchJob } from "../src/dispatch.ts";
import type { JobSpec, LinearWebhook } from "../src/domain.ts";
import { Recorder, RecordingSandbox } from "../src/sandbox.ts";
import { isFreshTimestamp, linearSource, verifyLinearSignature } from "../src/sources/linear.ts";
import { inMemoryStore, Store } from "../src/store.ts";

const issue = (overrides: {
  identifier?: string;
  description?: string;
  state?: string;
}): LinearWebhook => ({
  action: "update",
  type: "Issue",
  webhookTimestamp: 1,
  data: {
    id: "uuid",
    identifier: overrides.identifier ?? "ENG-123",
    title: "Add hello",
    description: overrides.description ?? "Do the thing.",
    state: { name: overrides.state ?? "Runway" },
  },
});

const piSpec: JobSpec = {
  id: "job-1",
  repo: { owner: "acme", name: "widgets" },
  branch: "runway/feature",
  plan: "Add a hello function.",
  agent: "pi",
  base: "main",
  validate: ["pnpm test"],
  title: "feat: add hello",
};

// Sandbox responder: changes staged, pi JSON stream ends with agent_end, gh prints the PR url.
const happyRun = (command: string) => {
  if (command.includes("git diff --cached --quiet")) return { exitCode: 1 };
  if (command.includes("--mode json")) return { stdout: '{"type":"agent_end"}\n' };
  if (command.includes("gh pr create"))
    return { stdout: "https://github.com/acme/widgets/pull/7\n" };
  return {};
};

describe("groundwork", () => {
  it("maps a Linear issue to a job, resolving the repo via the RepoMap", async () => {
    const store = inMemoryStore({ repoMap: { ws1: { ENG: "acme/widgets" } } });
    const config = {
      workspace: "ws1",
      defaultAgent: "pi",
      defaultBase: "main",
      triggerState: "Runway",
    } as const;

    const fromMap = await Effect.runPromise(
      linearSource.toJobSpec(issue({}), config).pipe(Effect.provide(store)),
    );
    expect(fromMap?.repo).toEqual({ owner: "acme", name: "widgets" });
    expect(fromMap?.branch).toBe("runway/eng-123");
    expect(fromMap?.agent).toBe("pi");

    // The in-issue `repo:` line is co-equal and, being most specific, wins over the map.
    const explicit = await Effect.runPromise(
      linearSource
        .toJobSpec(issue({ description: "repo: other/repo" }), config)
        .pipe(Effect.provide(store)),
    );
    expect(explicit?.repo).toEqual({ owner: "other", name: "repo" });
  });

  it("rejects a forged signature and a stale timestamp", async () => {
    const body = JSON.stringify({ hi: 1 });
    const secret = "whsec";
    const good = createHmac("sha256", secret).update(body).digest("hex");
    const raw = new TextEncoder().encode(body).buffer as ArrayBuffer;

    expect(await Effect.runPromise(verifyLinearSignature(raw, good, secret))).toBe(true);
    expect(
      await Effect.runPromise(verifyLinearSignature(raw, good.slice(0, -1) + "0", secret)),
    ).toBe(false);
    expect(await Effect.runPromise(verifyLinearSignature(raw, "short", secret))).toBe(false);

    const now = 1_000_000;
    expect(isFreshTimestamp(now - 30_000, now)).toBe(true);
    expect(isFreshTimestamp(now - 120_000, now)).toBe(false);
  });

  it("selects the right agent by key and emits its native command", async () => {
    const commandsFor = (name: "codex" | "pi") =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* agents[name].run({ ...piSpec, agent: name });
          return yield* Ref.get((yield* Recorder).commands);
        }).pipe(Effect.provide(RecordingSandbox({ exec: happyRun }))),
      );

    const codexCmds = await commandsFor("codex");
    expect(codexCmds.some((c) => c.includes("codex exec"))).toBe(true);

    const piCmds = await commandsFor("pi");
    expect(piCmds.some((c) => c.includes("pi --model openai-codex"))).toBe(true);
  });

  it("seeds the subscription credential, never leaks it, and writes back the rotated token", async () => {
    const store = inMemoryStore({ credentials: { codex: '{"tok":"SEED"}' } });
    const sandbox = RecordingSandbox({
      exec: happyRun,
      read: (path) => (path === "/work/.codex/auth.json" ? '{"tok":"ROTATED"}' : undefined),
    });

    const program = Effect.gen(function* () {
      yield* dispatchJob({ ...piSpec, agent: "codex" }, { githubToken: "GH-SECRET" });
      const writes = yield* Ref.get((yield* Recorder).writes);
      const env = yield* Ref.get((yield* Recorder).envVars);
      const commands = yield* Ref.get((yield* Recorder).commands);
      const stored = yield* (yield* Store).getCredential("codex");
      return { writes, env, commands, stored };
    });

    const out = await Effect.runPromise(
      program.pipe(Effect.provide(Layer.mergeAll(sandbox, store))),
    );

    expect(out.writes).toContainEqual({
      path: "/work/.codex/auth.json",
      content: '{"tok":"SEED"}',
    });
    expect(out.env.CODEX_HOME).toBe("/work/.codex");
    expect(out.env.GITHUB_TOKEN).toBe("GH-SECRET");
    const joined = out.commands.join("\n");
    expect(joined).not.toContain("SEED");
    expect(joined).not.toContain("ROTATED");
    expect(joined).not.toContain("GH-SECRET");
    expect(out.stored?.content).toBe('{"tok":"ROTATED"}');
  });

  it("runs a pi job and opens a draft PR in the sandbox via gh", async () => {
    const store = inMemoryStore({ credentials: { pi: '{"tok":"SEED"}' } });

    const program = Effect.gen(function* () {
      const result = yield* dispatchJob(piSpec, { githubToken: "GH-SECRET" });
      const commands = yield* Ref.get((yield* Recorder).commands);
      return { result, commands };
    });

    const out = await Effect.runPromise(
      program.pipe(Effect.provide(Layer.mergeAll(RecordingSandbox({ exec: happyRun }), store))),
    );

    expect(out.result.status).toBe("success");
    expect(out.result.pushed).toBe(true);
    expect(out.result.prUrl).toBe("https://github.com/acme/widgets/pull/7");
    expect(out.result.prNumber).toBe(7);
    expect(
      out.commands.some((c) => c.includes("gh pr create --draft") && c.includes("runway/feature")),
    ).toBe(true);
  });
});
