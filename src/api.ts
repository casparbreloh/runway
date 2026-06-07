import type * as cf from "@cloudflare/workers-types";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import AgentDO from "./agent-do.ts";
import { Db } from "./db.ts";
import { dispatchJob } from "./dispatch.ts";
import type { AgentName, JobSpec } from "./domain.ts";
import { sandboxLayer, type SandboxService } from "./sandbox.ts";
import { sources, type SourceConfig } from "./sources/index.ts";
import { verifyLinearSignature } from "./sources/linear.ts";
import { markdownSource } from "./sources/markdown.ts";
import { d1Store } from "./store-d1.ts";
import { importKey, Store } from "./store.ts";

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const isAgentName = (s: string): s is AgentName => s === "codex" || s === "pi";

const now = (): string => new Date().toISOString();

export default class Api extends Cloudflare.Worker<Api>()(
  "RunwayApi",
  {
    main: import.meta.filename,
    compatibility: { flags: ["nodejs_compat"], date: "2026-03-17" },
    env: {
      DB: Db,
      GITHUB_TOKEN: Config.redacted("GITHUB_TOKEN"),
      OPENAI_API_KEY: Config.redacted("OPENAI_API_KEY"),
      AUTH_BLOB_KEY: Config.redacted("AUTH_BLOB_KEY"),
      RUNWAY_API_TOKEN: Config.redacted("RUNWAY_API_TOKEN"),
      LINEAR_WEBHOOK_SECRET: Config.redacted("LINEAR_WEBHOOK_SECRET"),
      DEFAULT_AGENT: Config.string("DEFAULT_AGENT").pipe(Config.withDefault("codex")),
      DEFAULT_BASE: Config.string("DEFAULT_BASE").pipe(Config.withDefault("main")),
      DEFAULT_REPO: Config.string("DEFAULT_REPO").pipe(Config.withDefault("")),
      LINEAR_TRIGGER_STATE: Config.string("LINEAR_TRIGGER_STATE").pipe(Config.withDefault("")),
      LINEAR_TRIGGER_COMMENT: Config.string("LINEAR_TRIGGER_COMMENT").pipe(Config.withDefault("")),
    },
  },
  Effect.gen(function* () {
    const agentDO = yield* AgentDO;
    const conn = yield* Cloudflare.D1Connection.bind(Db);

    // Secrets and plain config resolved once at init (ConfigError allowed here).
    const githubToken = Redacted.value(yield* Config.redacted("GITHUB_TOKEN"));
    const openaiApiKey = Redacted.value(yield* Config.redacted("OPENAI_API_KEY"));
    const authBlobKey = Redacted.value(yield* Config.redacted("AUTH_BLOB_KEY"));
    const runwayApiToken = Redacted.value(yield* Config.redacted("RUNWAY_API_TOKEN"));
    const linearWebhookSecret = Redacted.value(yield* Config.redacted("LINEAR_WEBHOOK_SECRET"));
    const defaultAgentRaw = yield* Config.string("DEFAULT_AGENT").pipe(Config.withDefault("codex"));
    const defaultBase = yield* Config.string("DEFAULT_BASE").pipe(Config.withDefault("main"));
    const defaultRepo = yield* Config.string("DEFAULT_REPO").pipe(Config.withDefault(""));
    const triggerState = yield* Config.string("LINEAR_TRIGGER_STATE").pipe(Config.withDefault(""));
    const triggerComment = yield* Config.string("LINEAR_TRIGGER_COMMENT").pipe(
      Config.withDefault(""),
    );

    const config: SourceConfig = {
      defaultAgent: isAgentName(defaultAgentRaw) ? defaultAgentRaw : "codex",
      defaultBase,
      ...(defaultRepo ? { defaultRepo } : {}),
      ...(triggerState ? { triggerState } : {}),
      ...(triggerComment ? { triggerComment } : {}),
    };

    // Single D1 Store layer, built from the bound connection's raw handle so it
    // shares the worker's one D1 binding. Used by source.toJobSpec, runJob's
    // dispatch, and GET /jobs.
    const storeLayer = Layer.unwrap(
      Effect.gen(function* () {
        const rawDb = yield* conn.raw;
        const key = yield* importKey(authBlobKey);
        return d1Store(rawDb as cf.D1Database, key, now);
      }),
    );

    const sandboxFor = (spec: JobSpec): SandboxService => {
      const stub = agentDO.getByName(spec.id);
      const agent = spec.agent;
      return {
        exec: (command) =>
          stub.exec(agent, command).pipe(
            Effect.orElseSucceed(() => ({
              command,
              exitCode: 1,
              stdout: "",
              stderr: "agent-do exec failed",
            })),
          ),
        writeFile: (path, content) =>
          stub.writeFile(agent, path, content).pipe(Effect.orElseSucceed(() => undefined)),
        readFile: (path) => stub.readFile(agent, path).pipe(Effect.orElseSucceed(() => "")),
        setEnvVars: (env) =>
          stub.setEnvVars(agent, env).pipe(Effect.orElseSucceed(() => undefined)),
      };
    };

    const runJob = (spec: JobSpec) =>
      dispatchJob(spec, { githubToken, openaiApiKey }).pipe(
        Effect.provide(Layer.mergeAll(sandboxLayer(sandboxFor(spec)), storeLayer)),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const path = url.pathname;

        if (request.method === "GET" && path === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && path === "/webhooks/linear") {
          const raw = yield* request.arrayBuffer;
          const signature = request.headers["linear-signature"] ?? "";
          const valid = yield* verifyLinearSignature(raw, signature, linearWebhookSecret);
          if (!valid) return HttpServerResponse.empty({ status: 401 });

          let payload: { webhookTimestamp?: unknown };
          try {
            payload = JSON.parse(new TextDecoder().decode(raw)) as { webhookTimestamp?: unknown };
          } catch {
            return HttpServerResponse.empty({ status: 400 });
          }

          const ts = payload.webhookTimestamp;
          if (typeof ts !== "number" || Math.abs(Date.now() - ts) > 60_000) {
            return HttpServerResponse.empty({ status: 401 });
          }

          const spec = yield* sources.linear.toJobSpec(payload, config).pipe(
            Effect.provide(storeLayer),
            Effect.orElseSucceed(() => null),
          );
          if (!spec) return yield* HttpServerResponse.json({ ignored: true }, { status: 202 });

          yield* runJob(spec);
          return yield* HttpServerResponse.json({ jobId: spec.id }, { status: 202 });
        }

        if (request.method === "POST" && path === "/jobs") {
          const auth = request.headers["authorization"] ?? "";
          if (!constantTimeEqual(auth, `Bearer ${runwayApiToken}`)) {
            return HttpServerResponse.empty({ status: 401 });
          }

          const text = yield* request.text;
          let body: unknown;
          try {
            body = JSON.parse(text || "{}");
          } catch {
            return HttpServerResponse.empty({ status: 400 });
          }

          const spec = yield* markdownSource
            .toJobSpec(body, config)
            .pipe(Effect.provide(storeLayer), Effect.result);
          if (spec._tag === "Failure") {
            return yield* HttpServerResponse.json({ error: spec.failure.reason }, { status: 400 });
          }
          if (!spec.success) {
            return yield* HttpServerResponse.json({ ignored: true }, { status: 202 });
          }

          yield* runJob(spec.success);
          return yield* HttpServerResponse.json({ jobId: spec.success.id }, { status: 202 });
        }

        if (request.method === "GET" && path.startsWith("/jobs/")) {
          const id = path.slice("/jobs/".length);
          const job = yield* Store.pipe(
            Effect.flatMap((store) => store.getJob(id)),
            Effect.orElseSucceed(() => null),
            Effect.provide(storeLayer),
          );
          if (!job) return HttpServerResponse.empty({ status: 404 });
          return yield* HttpServerResponse.json(job);
        }

        return HttpServerResponse.empty({ status: 404 });
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.D1ConnectionLive)),
) {}
