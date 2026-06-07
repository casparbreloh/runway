import type * as cf from "@cloudflare/workers-types";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import AgentDO from "./agent-do.ts";
import { Db, SessionsBucket } from "./db.ts";
import type { AgentName } from "./domain.ts";
import { runFlow } from "./flow/engine.ts";
import { evalBool } from "./flow/expr.ts";
import { type FlowManifest, isWebhook } from "./flow/manifest.ts";
import { flowsById } from "./flows.ts";
import { sandboxLayer, type SandboxService } from "./sandbox.ts";
import { r2Sessions, Sessions } from "./sessions.ts";
import { verifySignature } from "./signature.ts";
import { d1Store } from "./store-d1.ts";
import { importKey, Store } from "./store.ts";

const SECRET_REF = /secrets\.([A-Za-z0-9_]+)/;

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const now = (): string => new Date().toISOString();

export default class Api extends Cloudflare.Worker<Api>()(
  "RunwayApi",
  {
    main: import.meta.filename,
    compatibility: { flags: ["nodejs_compat"], date: "2026-03-17" },
    env: {
      DB: Db,
      SESSIONS: SessionsBucket,
      AUTH_BLOB_KEY: Config.redacted("AUTH_BLOB_KEY"),
      RUNWAY_API_TOKEN: Config.redacted("RUNWAY_API_TOKEN"),
    },
  },
  Effect.gen(function* () {
    const agentDO = yield* AgentDO;
    const conn = yield* Cloudflare.D1Connection.bind(Db);
    const sessionsBucket = yield* Cloudflare.R2Bucket.bind(SessionsBucket);

    const authBlobKey = Redacted.value(yield* Config.redacted("AUTH_BLOB_KEY"));
    const runwayApiToken = Redacted.value(yield* Config.redacted("RUNWAY_API_TOKEN"));

    const storeLayer = Layer.unwrap(
      Effect.gen(function* () {
        const rawDb = yield* conn.raw;
        const key = yield* importKey(authBlobKey);
        return d1Store(rawDb as cf.D1Database, key, now);
      }),
    );

    const sessionsLayer = Layer.unwrap(
      Effect.gen(function* () {
        const raw = yield* sessionsBucket.raw;
        return Layer.succeed(Sessions, r2Sessions(raw as cf.R2Bucket));
      }),
    );

    const sandboxFor = (name: string, agent: AgentName): SandboxService => {
      const stub = agentDO.getByName(name);
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

    const getSecret = (name: string) =>
      Store.pipe(
        Effect.flatMap((store) => store.getCredential(name)),
        Effect.map((cred) => cred?.content ?? ""),
        Effect.orElseSucceed(() => ""),
        Effect.provide(storeLayer),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const execCtx = yield* Cloudflare.WorkerExecutionContext;
        const context = yield* Effect.context();
        const path = new URL(request.url, "http://localhost").pathname;

        // Run a flow detached via waitUntil so triggers return immediately (webhook
        // senders retry slow responses). `context` carries RuntimeContext + the
        // HttpClient at runtime; the cast reflects the program is fully provided.
        const launch = (manifest: FlowManifest, body: unknown): string => {
          const agent: AgentName = manifest.agent ?? "codex";
          const runId = `${manifest.id}-${crypto.randomUUID().slice(0, 8)}`;
          const program = runFlow(manifest, { body }).pipe(
            Effect.provide(
              Layer.mergeAll(sandboxLayer(sandboxFor(runId, agent)), storeLayer, sessionsLayer),
            ),
            Effect.provide(context),
          );
          const detached = Effect.ignore(program) as unknown as Effect.Effect<void>;
          execCtx.waitUntil(Effect.runPromise(detached));
          return runId;
        };

        if (request.method === "GET" && path === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        // Generic webhook trigger: verify via the flow's `trigger.sign`, filter on
        // `when`, then run. No per-provider code — the flow declares everything.
        if (request.method === "POST" && path.startsWith("/webhooks/")) {
          const manifest = flowsById[path.slice("/webhooks/".length)];
          if (!manifest || !isWebhook(manifest.trigger)) {
            return HttpServerResponse.empty({ status: 404 });
          }
          const webhook = manifest.trigger.webhook;
          const raw = yield* request.arrayBuffer;
          const secretName = SECRET_REF.exec(webhook.secret)?.[1] ?? "";
          const secret = yield* getSecret(secretName);
          const sign = webhook.sign ?? { header: "x-signature" };
          const signature = request.headers[sign.header.toLowerCase()] ?? "";
          if (!(yield* verifySignature(raw, signature, secret, sign))) {
            return HttpServerResponse.empty({ status: 401 });
          }

          let body: { webhookTimestamp?: unknown };
          try {
            body = JSON.parse(new TextDecoder().decode(raw)) as { webhookTimestamp?: unknown };
          } catch {
            return HttpServerResponse.empty({ status: 400 });
          }
          const ts = body.webhookTimestamp;
          if (typeof ts === "number" && Math.abs(Date.now() - ts) > 300_000) {
            return HttpServerResponse.empty({ status: 401 });
          }
          if (
            webhook.when &&
            !evalBool(webhook.when, { body, secrets: { [secretName]: secret } })
          ) {
            return yield* HttpServerResponse.json({ ignored: true }, { status: 202 });
          }
          return yield* HttpServerResponse.json({ jobId: launch(manifest, body) }, { status: 202 });
        }

        // Manual trigger: `runway run <flow>` posts the payload here.
        if (request.method === "POST" && path.startsWith("/run/")) {
          const auth = request.headers["authorization"] ?? "";
          if (!constantTimeEqual(auth, `Bearer ${runwayApiToken}`)) {
            return HttpServerResponse.empty({ status: 401 });
          }
          const manifest = flowsById[path.slice("/run/".length)];
          if (!manifest) return HttpServerResponse.empty({ status: 404 });
          let body: unknown;
          try {
            body = JSON.parse((yield* request.text) || "{}");
          } catch {
            return HttpServerResponse.empty({ status: 400 });
          }
          return yield* HttpServerResponse.json({ jobId: launch(manifest, body) }, { status: 202 });
        }

        // Secret write path: `runway secret set <name> <value>` posts here.
        if (request.method === "POST" && path === "/secrets") {
          const auth = request.headers["authorization"] ?? "";
          if (!constantTimeEqual(auth, `Bearer ${runwayApiToken}`)) {
            return HttpServerResponse.empty({ status: 401 });
          }
          let secretBody: { name?: unknown; value?: unknown };
          try {
            secretBody = JSON.parse((yield* request.text) || "{}") as {
              name?: unknown;
              value?: unknown;
            };
          } catch {
            return HttpServerResponse.empty({ status: 400 });
          }
          const { name, value } = secretBody;
          if (typeof name !== "string" || typeof value !== "string") {
            return yield* HttpServerResponse.json(
              { error: "name and value are required" },
              { status: 400 },
            );
          }
          yield* Store.pipe(
            Effect.flatMap((store) => store.putCredential(name, value)),
            Effect.orElseSucceed(() => undefined),
            Effect.provide(storeLayer),
          );
          return yield* HttpServerResponse.json({ ok: true });
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
  }).pipe(
    Effect.provide(Layer.mergeAll(Cloudflare.D1ConnectionLive, Cloudflare.R2BucketBindingLive)),
  ),
) {}
