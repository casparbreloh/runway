import { createHmac } from "node:crypto";
import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import type { JobSpec, LinearWebhook } from "../src/domain.ts";
import { eventToJobSpec, verifyLinearSignature } from "../src/Linear.ts";
import { Recorder, RecordingSandbox } from "../src/Sandbox.ts";
import { runCodexCloud } from "../src/executors/codexCloud.ts";
import { runPi } from "../src/executors/pi.ts";

const spec: JobSpec = {
  id: "job-1",
  repo: { owner: "acme", name: "widgets" },
  branch: "runway/feature",
  plan: "Add a hello function.",
  executor: "pi",
  base: "main",
  validate: ["pnpm test"],
  title: "feat: add hello",
};

describe("runway", () => {
  it("runs a pi job: clone, agent, validate, push a draft branch", async () => {
    const responder = (cmd: string) => {
      if (cmd.includes("git diff --cached --quiet")) return { exitCode: 1 };
      if (cmd.includes("pi --mode json")) return { stdout: '{"type":"agent_end"}\n' };
      return {};
    };

    const program = Effect.gen(function* () {
      const result = yield* runPi(spec, { githubToken: "secret-token", anthropicApiKey: "sk" });
      const commands = yield* Ref.get((yield* Recorder).commands);
      return { result, commands };
    });

    const { result, commands } = await Effect.runPromise(program.pipe(Effect.provide(RecordingSandbox(responder))));

    expect(result.status).toBe("success");
    expect(result.pushed).toBe(true);
    expect(commands.some((c) => c.includes("git clone"))).toBe(true);
    expect(commands.some((c) => c.includes("pi --mode json") && !c.includes("--approve"))).toBe(true);
    expect(commands.some((c) => c.includes("git push"))).toBe(true);
    expect(commands.join("\n")).not.toContain("secret-token");
  });

  it("runs a codex-cloud job: submits and returns the task url", async () => {
    const responder = () => ({ stdout: "https://chatgpt.com/codex/tasks/abc123\n" });
    const result = await Effect.runPromise(
      runCodexCloud({ ...spec, executor: "codex-cloud" }, { envId: "env-1" }).pipe(
        Effect.provide(RecordingSandbox(responder)),
      ),
    );

    expect(result.status).toBe("submitted");
    expect(result.taskId).toBe("abc123");
  });

  it("verifies a Linear webhook and maps it to a job", async () => {
    const secret = "whsec";
    const payload: LinearWebhook = {
      action: "create",
      type: "Issue",
      webhookTimestamp: 1,
      data: { id: "u1", identifier: "ENG-1", title: "Add hello", description: "repo: acme/widgets", state: { name: "Runway" } },
    };
    const body = JSON.stringify(payload);
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    const rawBody = new TextEncoder().encode(body).buffer as ArrayBuffer;

    const verified = await Effect.runPromise(verifyLinearSignature(rawBody, signature, secret));
    expect(verified).toBe(true);

    const job = await Effect.runPromise(
      eventToJobSpec(payload, { defaultExecutor: "pi", defaultBase: "main", triggerState: "Runway", triggerComment: "/runway" }),
    );
    expect(job?.repo).toEqual({ owner: "acme", name: "widgets" });
    expect(job?.executor).toBe("pi");
    expect(job?.branch).toBe("runway/eng-1");
  });
});
