import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { type AgentSecrets, withAgentAuth } from "../agent-auth.ts";
import { agents } from "../agents/index.ts";
import { type AgentName, type JobSpec, parseRepo } from "../domain.ts";
import { Sandbox } from "../sandbox.ts";
import { Store } from "../store.ts";
import { evalBool, evalValue, interpolate, interpolateValue } from "./expr.ts";
import {
  type FlowManifest,
  type HttpStep,
  isHttp,
  isRun,
  isShell,
  type RunStep,
} from "./manifest.ts";

const SAFE_REF = /^[A-Za-z0-9._/-]+$/;
const SECRET_REF = /secrets\.([A-Za-z0-9_]+)/g;

export const runKey = (manifestId: string, ref?: string): string =>
  `${manifestId}-${ref ? ref.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase() : "0"}`;

const toArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const collectSecretNames = (manifest: FlowManifest): readonly string[] => {
  const names = new Set<string>(["github"]);
  for (const match of JSON.stringify(manifest).matchAll(SECRET_REF)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
};

const loadSecrets = (
  names: readonly string[],
): Effect.Effect<Record<string, string>, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const out: Record<string, string> = {};
    for (const name of names) {
      const cred = yield* store.getCredential(name).pipe(Effect.orElseSucceed(() => null));
      if (cred) out[name] = cred.content;
    }
    return out;
  });

const buildSpec = (ctx: Record<string, unknown>, step: RunStep, index: number): JobSpec | null => {
  const repoSlug = typeof ctx["repo"] === "string" ? interpolate(ctx["repo"], ctx).trim() : "";
  if (!repoSlug) return null;
  let repo: JobSpec["repo"];
  try {
    repo = parseRepo(repoSlug);
  } catch {
    return null;
  }
  const branch = step.branch ? interpolate(step.branch, ctx) : `runway/${index}`;
  if (!SAFE_REF.test(branch)) return null;
  const title = typeof ctx["title"] === "string" ? ctx["title"] : undefined;
  return {
    id: branch.replaceAll("/", "-"),
    repo,
    branch,
    plan: interpolate(step.run, ctx),
    agent: ctx["agent"] as AgentName,
    base: typeof ctx["base"] === "string" ? ctx["base"] : "main",
    ...(title ? { title } : {}),
  };
};

const httpNode = (
  step: HttpStep["http"],
  ctx: Record<string, unknown>,
): Effect.Effect<unknown, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const method = (step.method ?? "GET").toUpperCase() as "GET";
    const headers = step.headers
      ? Object.fromEntries(Object.entries(step.headers).map(([k, v]) => [k, interpolate(v, ctx)]))
      : {};
    let request = HttpClientRequest.make(method)(interpolate(step.url, ctx)).pipe(
      HttpClientRequest.setHeaders(headers),
    );
    if (step.json !== undefined) {
      request = yield* HttpClientRequest.bodyJson(interpolateValue(step.json, ctx))(request);
    } else if (step.body !== undefined) {
      request = HttpClientRequest.bodyText(interpolate(step.body, ctx))(request);
    }
    const response = yield* client.execute(request);
    const text = yield* response.text;
    return { status: response.status, body: tryJson(text) };
  }).pipe(Effect.catch(() => Effect.succeed({ status: 0, body: null })));

const runSteps = (
  manifest: FlowManifest,
  ctx: Record<string, unknown>,
): Effect.Effect<void, never, Sandbox | Store | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const store = yield* Store;
    const steps = ctx["steps"] as Record<string, unknown>;

    let i = 0;
    for (const step of manifest.steps) {
      const id = step.id ?? `step${i}`;
      const items = step.forEach ? toArray(evalValue(step.forEach, ctx)) : [undefined];
      const outputs: unknown[] = [];
      let j = 0;
      for (const item of items) {
        const sctx = item === undefined ? ctx : { ...ctx, item, index: j };
        if (step.when && !evalBool(step.when, sctx)) {
          j++;
          continue;
        }
        let output: unknown = null;
        if (isRun(step)) {
          const spec = buildSpec(sctx, step, j);
          if (spec) {
            const result = yield* agents[spec.agent].run(spec, { pr: step.pr ?? false });
            yield* store.putJob(result).pipe(Effect.orElseSucceed(() => undefined));
            output = result;
          }
        } else if (isShell(step)) {
          const out = yield* sandbox.exec(interpolate(step.shell, sctx));
          output = { stdout: out.stdout, exitCode: out.exitCode, json: tryJson(out.stdout) };
        } else if (isHttp(step)) {
          output = yield* httpNode(step.http, sctx);
        }
        outputs.push(output);
        j++;
      }
      steps[id] = step.forEach ? outputs : (outputs[0] ?? null);
      i++;
    }
  });

export const runFlow = (
  manifest: FlowManifest,
  trigger: Record<string, unknown>,
  secrets: AgentSecrets,
): Effect.Effect<void, never, Sandbox | Store | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const secretMap = yield* loadSecrets(collectSecretNames(manifest));
    const agentName: AgentName =
      (typeof trigger["agent"] === "string" ? (trigger["agent"] as AgentName) : undefined) ??
      manifest.agent ??
      "codex";

    const ctx: Record<string, unknown> = {
      ...trigger,
      agent: agentName,
      secrets: secretMap,
      steps: {},
    };
    if (ctx["repo"] === undefined && manifest.repo !== undefined) ctx["repo"] = manifest.repo;

    yield* withAgentAuth(agentName, secrets, runSteps(manifest, ctx)).pipe(
      Effect.catchTag("AuthError", () => Effect.void),
    );
  });
