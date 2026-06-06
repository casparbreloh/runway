import { Effect, Ref } from "effect";
import { describe, expect, it } from "vitest";
import type { JobSpec } from "../src/domain.ts";
import { Recorder, RecordingSandbox } from "../src/Sandbox.ts";
import { runPi } from "../src/executors/pi.ts";

const FAKE_TOKEN = "FAKE-gh-token-do-not-leak";

const spec: JobSpec = {
  id: "job-1",
  repo: { owner: "acme", name: "widgets" },
  branch: "runway/feature",
  plan: "Add a hello function.",
  executor: "pi",
  base: "main",
  validate: ["npm test"],
  title: "feat: add hello",
};

// Changes present: 'git diff --cached --quiet' exits 1, and pi emits an agent_end event.
const withChanges = (command: string) => {
  if (command.includes("git diff --cached --quiet")) return { exitCode: 1 };
  if (command.includes("pi --mode json")) return { stdout: '{"type":"agent_start"}\n{"type":"agent_end"}\n' };
  return {};
};

describe("runPi", () => {
  it("clones, runs pi, validates, commits and pushes on changes", async () => {
    const program = Effect.gen(function* () {
      const result = yield* runPi(spec, { githubToken: FAKE_TOKEN });
      const rec = yield* Recorder;
      const commands = yield* Ref.get(rec.commands);
      const writes = yield* Ref.get(rec.writes);
      const envVars = yield* Ref.get(rec.envVars);
      return { result, commands, writes, envVars };
    });

    const { result, commands, writes, envVars } = await Effect.runPromise(
      program.pipe(Effect.provide(RecordingSandbox(withChanges))),
    );

    // Ordered command pipeline.
    const idx = (sub: string) => commands.findIndex((c) => c.includes(sub));
    const iClone = idx("git clone");
    const iCheckout = idx("git checkout -B");
    const iPi = idx("pi --mode json");
    const iValidate = idx("npm test");
    const iPush = idx("git push");
    expect(iClone).toBeGreaterThanOrEqual(0);
    expect(iClone).toBeLessThan(iCheckout);
    expect(iCheckout).toBeLessThan(iPi);
    expect(iPi).toBeLessThan(iValidate);
    expect(iValidate).toBeLessThan(iPush);

    // Pi 0.78.1 has no --approve flag.
    expect(commands.some((c) => c.includes("--approve"))).toBe(false);

    // PLAN.md is written with the plan body.
    expect(writes).toContainEqual({ path: "/work/repo/PLAN.md", content: spec.plan });

    // Token never appears literally; ${GITHUB_TOKEN} stays for shell expansion.
    const joined = commands.join("\n");
    expect(joined).not.toContain(FAKE_TOKEN);
    expect(joined).toContain("x-access-token:${GITHUB_TOKEN}@github.com");
    expect(envVars.GITHUB_TOKEN).toBe(FAKE_TOKEN);

    // Commit message is referenced via env, not interpolated.
    expect(commands.some((c) => c.includes('git commit -m "$RUNWAY_COMMIT_MSG"'))).toBe(true);
    expect(joined).not.toContain("feat: add hello");
    expect(envVars.RUNWAY_COMMIT_MSG).toBe("feat: add hello");

    expect(result.status).toBe("success");
    expect(result.pushed).toBe(true);
    expect(result.validated).toBe(true);
  });

  it("returns success with pushed:false when there are no changes", async () => {
    // Default responder: 'git diff --cached --quiet' exits 0 (no changes), pi still ends.
    const noChanges = (command: string) =>
      command.includes("pi --mode json") ? { stdout: '{"type":"agent_end"}\n' } : {};

    const result = await Effect.runPromise(
      runPi(spec, { githubToken: FAKE_TOKEN }).pipe(Effect.provide(RecordingSandbox(noChanges))),
    );

    expect(result.status).toBe("success");
    expect(result.pushed).toBe(false);
    expect(result.summary).toMatch(/no changes/);
  });

  it("fails when pi produces no agent_end event", async () => {
    const noEnd = (command: string) =>
      command.includes("pi --mode json") ? { stdout: '{"type":"agent_start"}\n' } : {};

    const result = await Effect.runPromise(
      runPi(spec, { githubToken: FAKE_TOKEN }).pipe(Effect.provide(RecordingSandbox(noEnd))),
    );

    expect(result.status).toBe("failure");
    expect(result.error).toBe("pi step failed");
  });

  it("fails when pi exits non-zero even with agent_end", async () => {
    const piErr = (command: string) =>
      command.includes("pi --mode json")
        ? { exitCode: 1, stdout: '{"type":"agent_end"}\n', stderr: "boom" }
        : {};

    const result = await Effect.runPromise(
      runPi(spec, { githubToken: FAKE_TOKEN }).pipe(Effect.provide(RecordingSandbox(piErr))),
    );

    expect(result.status).toBe("failure");
    expect(result.error).toMatch(/pi step failed/);
  });
});
