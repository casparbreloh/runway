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
// src/hello.ts
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

`createWorkflow({ id, trigger }).handler(fn)` defines a workflow. Each workflow is the default export
of its own file; you list those files by path in the config (see Wiring). Handlers are
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

Each workflow lives in its own file as the default export. Point `runway.config.ts` at a backend and
list those files by path:

```ts
// runway.config.ts
import { cloudflare } from "@runway/cloudflare";
import { defineConfig } from "@runway/core";

export default defineConfig({ backend: cloudflare(), workflows: ["src/hello.ts"] });
```

`workflows` is an explicit array of path strings — it holds paths, not imported workflow values, so
the config can import the Node backend without coupling it into the Worker. The CLI imports each
listed path, takes its `.default`, and validates it's tagged `__kind: "workflow"` (a clear build-time
error if a listed file forgot `export default createWorkflow(...)`), producing `{ path, def }` pairs.
The backend codegens a Worker that emits one default import per path plus one Cloudflare
`WorkflowEntrypoint` per workflow, bound by that import —
`import __w0 from "../src/hello.ts";` … `export class Hello extends toEntrypoint(__w0) {}`. The `id`
stays the deploy-time identity (the `workflow_name` and binding); the trigger path is the public
webhook route. No glob, no autodiscovery magic — just an explicit path list.

## CLI

- `runway build` — import each listed workflow path to collect the workflows, codegen the Worker (one
  `WorkflowEntrypoint` per workflow + trigger routing) and esbuild-bundle it. No
  upload — the offline shape proof.
- `runway deploy` — build, then upload via the typed `cloudflare` SDK (`cf.workers.scripts.update`
  with a `type: "workflow"` binding + `cf.workflows.update` per workflow). No wrangler, no Docker.

## Testing

- `pnpm test` — runs local no-account tests for CLI output, webhook auth, fake Workflow bindings,
  deploy upload bindings, public testing helpers, cron dispatch, and the example workflow.
- `cd example && runway build` — writes `.runway/worker.gen.ts`, `.runway/worker.js`, and
  `.runway/wrangler.jsonc`.

Use `@runway/cloudflare/testing` in app tests when you want to prove trigger auth and handler
execution without Cloudflare:

```ts
import { createTestWorker } from "@runway/cloudflare/testing";
import hello from "./src/hello.ts";

const worker = createTestWorker([hello], {
  secrets: { LINEAR_WEBHOOK_SECRET: "test-secret" },
});

const res = await worker.webhook("hello", { webhookTimestamp: Date.now() });
await worker.executions[0];
console.log(res.status); // 202
console.log(worker.runs[0]?.params);
```

You can run the generated Worker locally with Wrangler without a Cloudflare account:

```sh
cd example
runway build
wrangler dev --config .runway/wrangler.jsonc --local --var LINEAR_WEBHOOK_SECRET:test-secret
```

Then POST to the local trigger path with a matching signature. Local secret bindings must be passed
with `--var` or a Wrangler-supported local vars file; shell env vars are not automatically available
inside the Worker.

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
