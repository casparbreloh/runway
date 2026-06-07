import { Effect } from "effect";

import { type AgentSecrets, withAgentAuth } from "../agent-auth.ts";
import { agents } from "../agents/index.ts";
import { type AgentName, type JobResult, type JobSpec, parseRepo } from "../domain.ts";
import { Sandbox } from "../sandbox.ts";
import { sources } from "../sources/index.ts";
import { Store } from "../store.ts";
import { evalValue, interpolate } from "./expr.ts";
import { type FlowManifest, isReport, isRun, isShell, type RunStep } from "./manifest.ts";

export interface FlowSecrets extends AgentSecrets {
  readonly linearApiKey?: string;
}

const SOURCE_NAMES = new Set<string>(["linear", "markdown"]);

const toArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "run";

export const runKey = (manifestId: string, ref?: string): string =>
  `${manifestId}-${ref ? slug(ref) : "0"}`;

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const buildSpec = (
  manifest: FlowManifest,
  ctx: Record<string, unknown>,
  step: RunStep,
  index: number,
): JobSpec | null => {
  const repoSlug = typeof ctx["repo"] === "string" ? ctx["repo"] : undefined;
  if (!repoSlug) return null;
  let repo: JobSpec["repo"];
  try {
    repo = parseRepo(repoSlug);
  } catch {
    return null;
  }

  const ref =
    ctx["ref"] !== undefined ? slug(String(ctx["ref"] as string | number)) : String(index);
  const base = typeof ctx["base"] === "string" ? ctx["base"] : "main";
  const title = typeof ctx["title"] === "string" ? ctx["title"] : undefined;
  const sourceType = ctx["sourceType"];

  return {
    id: `${manifest.id}-${ref}`,
    repo,
    branch: `${manifest.id}/${ref}`,
    plan: interpolate(step.run, ctx),
    agent: ctx["agent"] as AgentName,
    base,
    ...(title ? { title } : {}),
    ...(typeof sourceType === "string" && SOURCE_NAMES.has(sourceType)
      ? {
          source: {
            type: sourceType as "linear" | "markdown",
            ...(ctx["ref"] !== undefined ? { ref: String(ctx["ref"] as string | number) } : {}),
          },
        }
      : {}),
  };
};

const reportBack = (
  ctx: Record<string, unknown>,
  result: JobResult,
  secrets: FlowSecrets,
): Effect.Effect<void> => {
  const type = ctx["sourceType"];
  if (typeof type !== "string" || !SOURCE_NAMES.has(type)) return Effect.void;
  const ref = ctx["ref"] !== undefined ? String(ctx["ref"] as string | number) : undefined;
  const opts = secrets.linearApiKey ? { linearApiKey: secrets.linearApiKey } : {};
  return sources[type as "linear" | "markdown"].report(result, ref, opts);
};

const runSteps = (
  manifest: FlowManifest,
  ctx: Record<string, unknown>,
  secrets: FlowSecrets,
): Effect.Effect<JobResult | null, never, Sandbox | Store> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const store = yield* Store;
    let last: JobResult | null = null;

    for (const step of manifest.steps) {
      const items = step.forEach ? toArray(evalValue(step.forEach, ctx)) : [undefined];
      let index = 0;
      for (const item of items) {
        const sctx = item === undefined ? ctx : { ...ctx, item, index };

        if (isRun(step)) {
          const spec = buildSpec(manifest, sctx, step, index);
          if (spec) {
            last = yield* agents[spec.agent].run(spec, { pr: step.pr ?? false });
            yield* store.putJob(last).pipe(Effect.orElseSucceed(() => undefined));
          }
        } else if (isShell(step)) {
          const out = yield* sandbox.exec(interpolate(step.shell, sctx));
          if (step.as) ctx[step.as] = tryJson(out.stdout);
        } else if (isReport(step) && last) {
          yield* reportBack(sctx, last, secrets);
        }
        index++;
      }
    }
    return last;
  });

export const runFlow = (
  manifest: FlowManifest,
  trigger: Record<string, unknown>,
  secrets: FlowSecrets,
): Effect.Effect<JobResult | null, never, Sandbox | Store> =>
  Effect.gen(function* () {
    const agentName: AgentName =
      (typeof trigger["agent"] === "string" ? (trigger["agent"] as AgentName) : undefined) ??
      manifest.agent ??
      "codex";

    const ctx: Record<string, unknown> = {
      ...(manifest.repo !== undefined ? { repo: manifest.repo } : {}),
      ...trigger,
      agent: agentName,
    };

    return yield* withAgentAuth(agentName, secrets, runSteps(manifest, ctx, secrets)).pipe(
      Effect.catchTag("AuthError", (e) =>
        Effect.succeed<JobResult | null>({
          jobId: manifest.id,
          agent: agentName,
          status: "failure",
          error: e.reason,
        }),
      ),
    );
  });
