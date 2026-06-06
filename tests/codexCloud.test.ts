import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import type { JobSpec } from "../src/domain.ts";
import { Recorder, RecordingSandbox } from "../src/Sandbox.ts";
import { runCodexCloud } from "../src/executors/codexCloud.ts";

const spec: JobSpec = {
  id: "job-1",
  repo: { owner: "acme", name: "widgets" },
  branch: "main",
  plan: "do the thing",
  executor: "codex-cloud",
  base: "main",
};

describe("runCodexCloud", () => {
  it("submits the plan and returns the task URL/id", async () => {
    const program = Effect.gen(function* () {
      const result = yield* runCodexCloud(spec, { envId: "env-9" });
      const rec = yield* Recorder;
      const commands = yield* Ref.get(rec.commands);
      return { result, commands };
    });

    const { result, commands } = await Effect.runPromise(
      program.pipe(
        Effect.provide(RecordingSandbox(() => ({ stdout: "https://chatgpt.com/codex/tasks/abc123\n" }))),
      ),
    );

    expect(commands.some((c) => c.includes("codex cloud exec --env"))).toBe(true);
    expect(result.status).toBe("submitted");
    expect(result.taskId).toBe("abc123");
    expect(result.taskUrl).toBe("https://chatgpt.com/codex/tasks/abc123");
  });

  it("fails when envId is missing", async () => {
    const result = await Effect.runPromise(
      runCodexCloud(spec, { envId: "" }).pipe(Effect.provide(RecordingSandbox())),
    );

    expect(result.status).toBe("failure");
    expect(result.error).toBe("missing CODEX_CLOUD_ENV_ID");
  });

  it("logs in with an access token and sets CODEX_ACCESS_TOKEN", async () => {
    const program = Effect.gen(function* () {
      yield* runCodexCloud(spec, { envId: "env-9", accessToken: "tok-secret" });
      const rec = yield* Recorder;
      const commands = yield* Ref.get(rec.commands);
      const envVars = yield* Ref.get(rec.envVars);
      return { commands, envVars };
    });

    const { commands, envVars } = await Effect.runPromise(
      program.pipe(
        Effect.provide(RecordingSandbox(() => ({ stdout: "https://chatgpt.com/codex/tasks/abc123\n" }))),
      ),
    );

    expect(commands.some((c) => c.includes("codex login --with-access-token"))).toBe(true);
    expect(envVars.CODEX_ACCESS_TOKEN).toBe("tok-secret");
  });

  it("fails when exec produces no task URL", async () => {
    const result = await Effect.runPromise(
      runCodexCloud(spec, { envId: "env-9" }).pipe(
        Effect.provide(RecordingSandbox(() => ({ stdout: "" }))),
      ),
    );

    expect(result.status).toBe("failure");
    expect(result.error).toMatch(/no task URL/);
  });
});
