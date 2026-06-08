/**
 * Runs INSIDE the Runway sandbox container (baked in by the Dockerfile). Drives
 * pi via its SDK so the Worker gets a typed result instead of scraping CLI stdout.
 *
 * Invoked by the Worker as: `node /app/dist/runner.js <input.json> <result.json>`.
 * The summary itself comes from the PR.md the agent writes; this runner only
 * drives the session and reports success/failure.
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type { RunnerInput, RunnerOutput } from "runway/agent-protocol";

async function run(input: RunnerInput): Promise<RunnerOutput> {
  const slash = input.model.indexOf("/");
  const provider = input.model.slice(0, slash);
  const modelId = input.model.slice(slash + 1);

  const modelRegistry = ModelRegistry.create(AuthStorage.create());
  const model = modelRegistry.find(provider, modelId);
  if (!model) return { ok: false, error: `unknown model: ${input.model}` };

  const { session } = await createAgentSession({ cwd: input.cwd, model, modelRegistry });

  let failure: string | undefined;
  const unsubscribe = session.subscribe((e: AgentSessionEvent) => {
    if (e.type === "auto_retry_end" && !e.success) failure = e.finalError ?? "agent retry failed";
  });

  try {
    await session.prompt(input.prompt);
  } finally {
    unsubscribe();
    session.dispose();
  }

  return failure ? { ok: false, error: failure } : { ok: true };
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (inputPath === undefined || outputPath === undefined) {
    throw new Error("usage: runner.js <input.json> <result.json>");
  }
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as RunnerInput;
  const result = await run(input).catch(
    (err: unknown): RunnerOutput => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  writeFileSync(outputPath, JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

await main();
