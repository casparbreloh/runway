# Runway

TypeScript-first workflow infrastructure for repository automation, CI/CD-style checks, custom
triggers, scheduled work, webhooks, and agent-native execution on Cloudflare. You author workflows
with the `runway` package and deploy them with the `runway` CLI. Cloudflare owns replay,
persistence, durable sleep, cron schedules, webhook routing, and sandboxed agent execution.

For the product direction, architecture, and non-goals, see [`.docs/VISION.md`](.docs/VISION.md).

## A workflow

```ts
// .runway/workflows/hello.ts
import { cron, workflow } from "runway";

export default workflow({
  id: "hello",
  trigger: () => cron("0 9 * * *"),
}).handler(async (ctx, event) => {
  const greeting = await ctx.step("greet", () => "hello");
  await ctx.sleep(5000);
  await ctx.step("finish", () => `${greeting} world (run ${ctx.runId})`);
});
```

`workflow({ id, secrets?, trigger }).handler(fn)` defines the core primitive for repository
automation, CI/CD-style checks, webhook automations, scheduled jobs, and agent work. The trigger is
a required callback and the typed event is the handler's second argument. Export workflows from
files under `.runway/workflows`; default exports, named exports, and barrel re-exports are
supported. Handlers are fire-and-forget — they return nothing. The durable primitives are `ctx.step`
(a memoized durable step, named by its idempotency key), `ctx.ai` (a named OpenRouter call),
`ctx.agent` (Pi inside a Cloudflare Sandbox), `ctx.sandbox` (the raw Sandbox escape hatch), and
`ctx.sleep` (durable sleep, just a number of ms). Anything else — an HTTP call, for example — is
plain TypeScript wrapped inside a primitive.

## Triggers

Triggers are explicit. There is no default public start endpoint.

```ts
import { webhook, workflow } from "runway";
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

The handler's first argument is the workflow context
`{ runId, secrets, env, step, ai, agent, sandbox, sleep }`:

- `ctx.runId` — the run instance id.
- `ctx.secrets` — the declared secrets as a typed record of name → value.
- `ctx.env` — the raw Cloudflare environment, typed `unknown`; an escape hatch for advanced use.
- `ctx.step(id, fn)` — a durable, memoized step; `id` is the idempotency key and `fn` receives
  `{ id }`. Returns a JSON-serializable value. Steps re-run on replay, so keep them idempotent.
- `ctx.ai(id, opts)` — a durable, memoized OpenRouter chat completion. Use it for simple LLM calls
  that do not need files or command execution.
- `ctx.agent(id, opts)` — a durable, memoized Pi run inside a Cloudflare Sandbox. Runway writes
  optional files into `/workspace`, executes `npx --yes @earendil-works/pi-coding-agent@0.79.1`
  with your `args` and `env`, and returns stdout.
- `ctx.sandbox(id, fn)` — a durable, memoized step that creates/opens a Cloudflare Sandbox for this
  workflow run and passes it to `fn`. Use it for custom isolated command execution.
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

The CLI discovers exported workflows from `.runway/workflows/**/*.ts`, excluding `**/*.test.ts`,
`**/*.spec.ts`, and `**/*.d.ts`. There is no `runway.config.ts`.

Deploy codegens one Cloudflare Worker named `runway`. That Worker is a Dynamic Workflows loader: it
owns webhook and cron routing, uses one Cloudflare Workflow binding named `WORKFLOWS`, and loads each
repository workflow through a Cloudflare Worker Loader binding named `LOADER`. It also owns the
hidden Cloudflare Sandbox Durable Object/container used by `ctx.agent` and `ctx.sandbox`. No wrangler
config and no generated files on disk. The workflow `id` is the Runway routing identity; the
deployed Cloudflare Workflow resource is the singleton `runway`.

Pi is intentionally invoked with `npx` inside the Sandbox rather than added as a package dependency:
the CLI runs in the isolated execution environment, not in Runway's deploy bundle.

For this first Cloudflare-native PR, workflow resumes use the latest deployed workflow code and
secrets. Version-pinned resumes require durable artifact storage and are intentionally left for the
future registry/control-plane work.

## CLI

- `runway deploy` — discover workflow exports, codegen and bundle the Worker in memory, then upload
  via the typed `cloudflare` SDK (`cf.workers.scripts.update` with `worker_loader`, Dynamic
  Workflows, Sandbox Durable Object, container, migration, and declared `secret_text` bindings;
  `cf.workflows.update("runway", ...)`). The Worker script name is always `runway`. Runway does not
  shell out to `wrangler deploy`. Prints the script name and one POST URL per webhook trigger.

## Example

See `example/.runway/workflows/issue-review.ts` for the full dogfood: a Linear webhook typed with
`@linear/sdk`'s `LinearWebhookPayload` and narrowed with `.filter` to created issues, starts a
Pi review with `ctx.agent` against the issue using OpenRouter credentials, and posts the review back
as a comment with `@linear/sdk`'s `createComment` inside `ctx.step`.

## Testing

- `pnpm test` — runs package-owned Vitest tests. The Workers-runtime trigger tests run under
  `@cloudflare/vitest-pool-workers`.
- `pnpm typecheck` includes the example workflow; deploy tests cover the codegen/bundle/upload path
  with a mocked Cloudflare SDK.

Deploying needs every workflow-declared secret in the environment. For Cloudflare auth, use either
Wrangler login locally or explicit env vars in CI:

```sh
wrangler login
runway deploy
```

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export LINEAR_WEBHOOK_SECRET=...
runway deploy
```

If Wrangler is logged into multiple Cloudflare accounts, set `CLOUDFLARE_ACCOUNT_ID`.

Deploy prints one POST URL per webhook trigger. Start a run by POSTing a signed body to it:

```sh
curl -X POST https://<script>.<subdomain>.workers.dev/webhooks/linear \
  -H "linear-signature: <hmac-sha256-hex-of-body>" \
  -d '{"webhookTimestamp": <now-ms>}'
```
