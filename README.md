# Runway

A code-first TypeScript library for durable workflows. The core (`@runway/core`) is a portable,
Web-Standards-only authoring SDK with zero Cloudflare deps that owns the durable-execution contract;
the durable runtime is a **pluggable backend**. Today there is one — `@runway/cloudflare`, backed by
native Cloudflare Workflows, which owns replay, persistence, and durable sleep. The `Backend` seam
keeps your workflows portable, so other backends (Vercel, self-hosted Postgres) can be added later
without touching authoring code.

You author with `@runway/core` but run the `runway` CLI, which `@runway/core` ships as its `bin`.

## A workflow

```ts
// .runway/workflows/hello.ts
import { createWorkflow, cron } from "@runway/core";

export default createWorkflow({
  id: "hello",
  trigger: cron("0 9 * * *"),
}).handler(async (ctx) => {
  const greeting = await ctx.step("greet", () => "hello");
  await ctx.sleep(5000);
  await ctx.step("finish", () => `${greeting} world (run ${ctx.runId})`);
});
```

`createWorkflow({ id, trigger }).handler(fn)` defines a workflow. Export workflows from files under
`.runway/workflows`; default exports, named exports, and barrel re-exports are supported. Handlers are
fire-and-forget — they return nothing. The only durable primitives are `ctx.step` (a memoized durable
step, named by its idempotency key) and `ctx.sleep` (durable sleep, just a number of ms). Anything
else — an HTTP call, for example — is plain TypeScript wrapped inside a `ctx.step`.

## Triggers

Triggers are explicit. There is no default public start endpoint.

```ts
import { createWorkflow, cron, hmacSha256, webhook } from "@runway/core";

createWorkflow({
  id: "linear",
  trigger: webhook({
    path: "/webhooks/linear",
    auth: hmacSha256({
      header: "linear-signature",
      secret: "LINEAR_WEBHOOK_SECRET",
      timestamp: { field: "webhookTimestamp", toleranceMs: 60_000 },
    }),
  }),
});
createWorkflow({ id: "daily-report", trigger: cron("0 9 * * *") });
```

Webhook triggers are POST-only, verify the provider signature against the named env var, and pass
the JSON body through as workflow params. Cron triggers start from Cloudflare Worker Cron Triggers
and pass `{ cron, scheduledTime }` as params.

Use `hmacSha256(...)` for providers with raw-body HMAC signatures:

```ts
webhook({
  path: "/webhooks/github",
  auth: hmacSha256({
    header: "x-hub-signature-256",
    secret: "GITHUB_WEBHOOK_SECRET",
    prefix: "sha256=",
  }),
});
```

The `secret` value is the environment variable name that contains the webhook signing secret.

Configure which events send webhooks in the provider itself — for example Linear issue/comment events
in Linear's webhook settings. Runway verifies the delivery and starts the workflow; filter or branch
on `ctx.params` inside the workflow when one endpoint receives multiple event types.

## `ctx`

The single handler argument is just `{ runId, params, step, sleep }`:

- `ctx.runId` — the run instance id.
- `ctx.params` — the trigger payload as `unknown`.
- `ctx.step(id, fn)` — a durable, memoized step; `id` is the idempotency key and `fn` receives
  `{ id }`. Returns a JSON-serializable value. Steps re-run on replay, so keep them idempotent.
- `ctx.sleep(ms)` — durable sleep. `ms` is a plain number of milliseconds; there is no id and no
  duration string.

## Wiring

Point `runway.config.ts` at a backend. The CLI discovers exported workflows from
`.runway/workflows/**/*.ts` by default:

```ts
// runway.config.ts
import { cloudflare } from "@runway/cloudflare";
import { defineConfig } from "@runway/core";

export default defineConfig({ backend: cloudflare() });
```

Customize discovery with repo-root-relative globs when needed:

```ts
export default defineConfig({
  backend: cloudflare(),
  include: [".runway/*.ts"],
  exclude: ["**/*.test.ts"],
});
```

Default excludes are `**/*.test.ts`, `**/*.spec.ts`, and `**/*.d.ts`. The backend codegens a Worker
that namespace-imports each matched module and creates one Cloudflare `WorkflowEntrypoint` per
workflow export. The `id` stays the deploy-time identity (the `workflow_name` and binding); the
trigger path is the public webhook route.

## CLI

- `runway deploy` — discover workflow exports, codegen and bundle the Worker, then upload via
  the typed `cloudflare` SDK (`cf.workers.scripts.update` with a `type: "workflow"` binding +
  `cf.workflows.update` per workflow). No wrangler, no Docker.

## Testing

- `pnpm test` — runs package-owned Vitest tests. Core owns the CLI test; Cloudflare owns deploy and
  Workers-runtime trigger tests, with the runtime test running under `@cloudflare/vitest-pool-workers`.
- `pnpm typecheck` includes the example workflow; deploy tests cover the codegen/bundle/upload path
  with a mocked Cloudflare SDK.

Deploying needs Cloudflare credentials in the environment:

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
runway deploy
```

Once deployed, start a run by POSTing to the Worker (the body is passed through as the run params):

```sh
curl -X POST https://<your-worker>/hello \
  -H "linear-signature: <hmac-of-body>" \
  -d '{"webhookTimestamp": <now-ms>}'
```
