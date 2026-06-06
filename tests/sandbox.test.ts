import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { Recorder, RecordingSandbox, Sandbox } from "../src/Sandbox.ts";

describe("RecordingSandbox", () => {
  it("records commands, writes, and env vars", async () => {
    const program = Effect.gen(function* () {
      const sandbox = yield* Sandbox;
      yield* sandbox.exec("git status");
      yield* sandbox.writeFile("/work/plan.md", "do the thing");
      yield* sandbox.setEnvVars({ FOO: "1" });
      yield* sandbox.setEnvVars({ BAR: "2" });

      const rec = yield* Recorder;
      const commands = yield* Ref.get(rec.commands);
      const writes = yield* Ref.get(rec.writes);
      const envVars = yield* Ref.get(rec.envVars);
      return { commands, writes, envVars };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(RecordingSandbox())));

    expect(result.commands).toEqual(["git status"]);
    expect(result.writes).toEqual([{ path: "/work/plan.md", content: "do the thing" }]);
    expect(result.envVars).toEqual({ FOO: "1", BAR: "2" });
  });

  it("defaults exitCode to 0 and stdout/stderr to empty when no responder", async () => {
    const program = Effect.gen(function* () {
      const sandbox = yield* Sandbox;
      return yield* sandbox.exec("echo hi");
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(RecordingSandbox())));

    expect(result).toEqual({ command: "echo hi", exitCode: 0, stdout: "", stderr: "" });
  });

  it("flows a custom responder's exitCode/stdout/stderr through exec", async () => {
    const responder = (command: string) =>
      command.startsWith("npm test")
        ? { exitCode: 1, stdout: "1 failing", stderr: "boom" }
        : { stdout: "ok" };

    const program = Effect.gen(function* () {
      const sandbox = yield* Sandbox;
      const failing = yield* sandbox.exec("npm test");
      const passing = yield* sandbox.exec("git status");
      const rec = yield* Recorder;
      const commands = yield* Ref.get(rec.commands);
      return { failing, passing, commands };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(RecordingSandbox(responder))));

    // non-zero exitCode is DATA, not a failure — exec still succeeds.
    expect(result.failing).toEqual({ command: "npm test", exitCode: 1, stdout: "1 failing", stderr: "boom" });
    expect(result.passing).toEqual({ command: "git status", exitCode: 0, stdout: "ok", stderr: "" });
    expect(result.commands).toEqual(["npm test", "git status"]);
  });
});
