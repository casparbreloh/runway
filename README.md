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

export default createWorkflow({ id: "hello" })
  .trigger(cron("0 9 * * *"))
  .handler(async (ctx) => {
    const greeting = await ctx.step("greet", () => "hello");
    await ctx.sleep(5000);
    await ctx.step("finish", () => `${greeting} world (run ${ctx.runId})`);
  });
```

`createWorkflow({ id, secrets? }).trigger(...).handler(fn)` defines a workflow — the trigger is a
required chained call. Export workflows from files under
`.runway/workflows`; default exports, named exports, and barrel re-exports are supported. Handlers are
fire-and-forget — they return nothing. The only durable primitives are `ctx.step` (a memoized durable
step, named by its idempotency key) and `ctx.sleep` (durable sleep, just a number of ms). Anything
else — an HTTP call, for example — is plain TypeScript wrapped inside a `ctx.step`.

## Triggers

Triggers are explicit. There is no default public start endpoint.

```ts
import { createWorkflow, cron, webhook } from "@runway/core";

createWorkflow({ id: "linear", secrets: ["LINEAR_WEBHOOK_SECRET"] }).trigger(
  webhook({
    path: "/webhooks/linear",
    secret: "LINEAR_WEBHOOK_SECRET",
    header: "linear-signature",
    timestamp: { field: "webhookTimestamp", toleranceMs: 60_000 },
  }),
);
createWorkflow({ id: "daily-report" }).trigger(cron("0 9 * * *"));
```

Webhook triggers are POST-only and verify a raw-body HMAC-SHA256 signature — the only webhook auth,
so its options live flat on the webhook (providers that prefix the signature take
`prefix: "sha256="`). `secret` names one of the workflow's declared `secrets`, typed against the
declared union — a typo or undeclared name is a type error. Cron triggers start from Cloudflare
Worker Cron Triggers and type `ctx.params` as `{ cron, scheduledTime }`.

A webhook's optional second argument `handle(body)` is raw TypeScript run at the router after HMAC
auth: return `undefined`/`null` to skip the event (200 `{ skipped: true }`, no run started), or
return a value to make it the run's `ctx.params` — typed by inference from the return, no generics.
Without `handle`, `ctx.params` is the raw parsed body (`unknown`).

```ts
webhook(
  { path: "/webhooks/linear", secret: "LINEAR_WEBHOOK_SECRET", header: "linear-signature" },
  (event: LinearWebhookPayload) =>
    event.type === "Issue" && event.action === "create" ? event.data : undefined,
);
```

Configure which events send webhooks in the provider itself — for example Linear issue/comment events
in Linear's webhook settings. One webhook URL can receive an event firehose; `handle` filters it
without burning runs.

## `ctx`

The single handler argument is just `{ runId, params, secrets, env, step, sleep }`:

- `ctx.runId` — the run instance id.
- `ctx.params` — the trigger payload: the `handle` return for webhooks (the raw parsed body as
  `unknown` without one), `{ cron, scheduledTime }` for cron.
- `ctx.secrets` — the declared secrets as a typed record of name → value.
- `ctx.env` — the backend's raw environment, typed `unknown`; the escape hatch to backend-specific
  bindings (like the sandbox DO namespace) — cast it in the workflow.
- `ctx.step(id, fn)` — a durable, memoized step; `id` is the idempotency key and `fn` receives
  `{ id }`. Returns a JSON-serializable value. Steps re-run on replay, so keep them idempotent.
- `ctx.sleep(ms)` — durable sleep. `ms` is a plain number of milliseconds; there is no id and no
  duration string.

## Secrets

`secrets: [...]` on `createWorkflow` names every secret the workflow needs — the webhook signing
secret included. The names infer as a literal union, so `ctx.secrets.LINEAR_API_KEY` is `string`
and any undeclared key is a type error. Deploy is gated on them: it fails before upload when a
declared secret is missing from the deploy env, and values upload as `secret_text` bindings.
Non-secret config doesn't belong in `secrets` — it's plain TypeScript in the workflow file.

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
workflow export — fully in memory, no wrangler config, no generated files on disk. The `id` stays
the deploy-time identity (the `workflow_name` and binding); the trigger path is the public webhook
route.

## CLI

- `runway deploy` — discover workflow exports, codegen and bundle the Worker in memory, then upload
  via the typed `cloudflare` SDK (`cf.workers.scripts.update` with a `type: "workflow"` binding per
  workflow plus `secret_text` bindings for the declared secrets + `cf.workflows.update` per
  workflow). No wrangler, no Docker. Prints the script name and one POST URL per webhook trigger.

## Sandbox

`cloudflare({ sandbox: true })` additionally provisions a Cloudflare Sandbox — still no Docker, no
wrangler: the script gains a `Sandbox` Durable Object binding and a container application pointing
at the prebuilt `docker.io/cloudflare/sandbox` image. Inside a workflow step, use
`@cloudflare/sandbox`'s `getSandbox` against `ctx.env`:

```ts
const { getSandbox } = await import("@cloudflare/sandbox");
const sandbox = getSandbox((ctx.env as SandboxEnv).Sandbox, ctx.runId);
const result = await sandbox.exec("echo hello");
```

See `example/.runway/workflows/issue-review.ts` for the full dogfood: a Linear issue-created webhook
that runs a coding agent in a sandbox against the issue and posts the review back as a comment.

## Testing

- `pnpm test` — runs package-owned Vitest tests. Core owns the CLI test; Cloudflare owns deploy and
  Workers-runtime trigger tests, with the runtime test running under `@cloudflare/vitest-pool-workers`.
- `pnpm typecheck` includes the example workflow; deploy tests cover the codegen/bundle/upload path
  with a mocked Cloudflare SDK.

Deploying needs Cloudflare credentials plus every workflow-declared secret in the environment:

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export LINEAR_WEBHOOK_SECRET=...
runway deploy
```

Deploy prints one POST URL per webhook trigger. Start a run by POSTing a signed body to it:

```sh
curl -X POST https://<script>.<subdomain>.workers.dev/webhooks/linear \
  -H "linear-signature: <hmac-sha256-hex-of-body>" \
  -d '{"webhookTimestamp": <now-ms>}'
```
