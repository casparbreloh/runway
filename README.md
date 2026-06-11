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
import { cron, workflow } from "@runway/core";

export default workflow({
  id: "hello",
  trigger: () => cron("0 9 * * *"),
}).handler(async (ctx, event) => {
  const greeting = await ctx.step("greet", () => "hello");
  await ctx.sleep(5000);
  await ctx.step("finish", () => `${greeting} world (run ${ctx.runId})`);
});
```

`workflow({ id, secrets?, trigger }).handler(fn)` defines a workflow — the trigger is a required
callback and the typed event is the handler's second argument. Export workflows from files under
`.runway/workflows`; default exports, named exports, and barrel re-exports are supported. Handlers
are fire-and-forget — they return nothing. The only durable primitives are `ctx.step` (a memoized
durable step, named by its idempotency key) and `ctx.sleep` (durable sleep, just a number of ms).
Anything else — an HTTP call, for example — is plain TypeScript wrapped inside a `ctx.step`.

## Triggers

Triggers are explicit. There is no default public start endpoint.

```ts
import { webhook, workflow } from "@runway/core";
import { z } from "zod";

const issueCreated = z.object({
  type: z.literal("Issue"),
  action: z.literal("create"),
  data: z.object({ id: z.string(), title: z.string() }),
});

export default workflow({
  id: "linear",
  secrets: ["LINEAR_WEBHOOK_SECRET"],
  trigger: (ctx) =>
    webhook({
      path: "/webhooks/linear",
      secret: ctx.secrets.LINEAR_WEBHOOK_SECRET,
      signatureHeader: "linear-signature",
      timestamp: { field: "webhookTimestamp", toleranceMs: 60_000 },
      schema: issueCreated,
    }),
}).handler(async (ctx, event) => {
  // event is typed by the schema: { type: "Issue"; action: "create"; data: { id, title } }
});
```

Webhook triggers are POST-only and verify a raw-body HMAC-SHA256 signature — the only webhook auth,
so its options live flat on the webhook (providers that prefix the signature take
`prefix: "sha256="`). `secret` takes `ctx.secrets.X` from the trigger callback's context — a branded
reference to one of the workflow's declared `secrets`, so a typo or undeclared name is a type error
at the dot. Cron triggers type the event as `{ cron, scheduledTime }`.

How the event is typed is a three-rung ladder:

- `webhook({ schema })` — validate the parsed body with any Standard Schema (zod, valibot, ...);
  the event is the validate **output**, so transforms apply. An event that fails the schema is
  skipped (200 `{ skipped: true }`, no run started) — the schema doubles as the firehose filter,
  so one webhook URL can receive every event a provider sends without burning runs.
- `webhook<T>(opts)` — assertion-only typing, no runtime validation.
- `webhook(opts)` — the raw parsed body as `unknown`.

`.filter(typeGuard)` narrows after any rung — it must be a type-guard predicate, AND-composes with
prior filters, and returns a new trigger. A predicate returning false skips the event.

Two workflows may share one webhook path to fan out from a single event source — verification config
must be identical on the shared path, the signature is verified once, and each workflow's
schema/filter gates its own run. The response is `202 { runs: [...] }` when at least one run
started, `200 { skipped: true }` when none did. Signed-but-malformed JSON is a 400; a throwing
predicate or rejecting schema validation is a 500 and starts no runs.

## `ctx`

The handler's first argument is `{ runId, secrets, env, step, sleep }`:

- `ctx.runId` — the run instance id.
- `ctx.secrets` — the declared secrets as a typed record of name → value.
- `ctx.env` — the backend's raw environment, typed `unknown`; the escape hatch to backend-specific
  bindings — cast it in the workflow.
- `ctx.step(id, fn)` — a durable, memoized step; `id` is the idempotency key and `fn` receives
  `{ id }`. Returns a JSON-serializable value. Steps re-run on replay, so keep them idempotent.
- `ctx.sleep(ms)` — durable sleep. `ms` is a plain number of milliseconds; there is no id and no
  duration string.

## Secrets

`secrets: [...]` on `workflow` names every secret the workflow needs — the webhook signing secret
included. Secrets live in two worlds: in the trigger callback, `ctx.secrets.X` is a branded
name reference (values don't exist at authoring time) that `webhook({ secret })` requires; in the
handler, `ctx.secrets.X` is the `string` value. Any undeclared key is a type error in both. Deploy
is gated on them: it fails before upload when a declared secret is missing from the deploy env, and
values upload as `secret_text` bindings. Non-secret config doesn't belong in `secrets` — it's plain
TypeScript in the workflow file.

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

## Example

See `example/.runway/workflows/issue-review.ts` for the full dogfood: a Linear webhook typed with
`@linear/sdk`'s `LinearWebhookPayload` and narrowed with `.filter` to created issues, runs an LLM
review with `@openrouter/sdk` inside a `ctx.step` against the issue, and posts the review back as a
comment with `@linear/sdk`'s `createComment` inside another `ctx.step`.

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
