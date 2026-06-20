# Runway

TypeScript-first workflow infrastructure for repository automation, scheduled work, webhooks, and
agent-native execution on Cloudflare. Author workflows with `runway`, deploy them with `runway
deploy`, and let Cloudflare own routing, replay, persistence, durable sleep, schedules, and Sandbox
execution.

For product direction and non-goals, see [`.docs/VISION.md`](.docs/VISION.md).

## A Workflow

```ts
// .runway/workflows/hello.ts
import { cron, workflow } from "runway";

export default workflow({
  id: "hello",
  trigger: () => cron("0 9 * * *"),
}).handler(async (ctx, event) => {
  const greeting = await ctx.step("greet", () => "hello");
  await ctx.sleep(5000);
  await ctx.step("finish", () => `${greeting} world at ${event.scheduledTime}`);
});
```

Export workflows from `.runway/workflows/**/*.ts`. Default exports, named exports, and barrel
re-exports are supported. The core shape is:

```ts
workflow({ id, secrets?, trigger }).handler(async (ctx, event) => {});
```

Handlers are fire-and-forget. Use durable primitives for work Cloudflare may replay:

- `ctx.step(id, fn)` for memoized work with an idempotency key.
- `ctx.sleep(ms)` for durable waits.
- `ctx.ai(id, opts)` for durable OpenRouter chat completions.
- `ctx.agent(id, opts)` for Pi runs inside Cloudflare Sandbox.
- `ctx.sandbox(id, fn)` for custom Sandbox command execution.

## Quickstart

```sh
wrangler login
runway deploy
```

In CI:

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=... # required when the token can see multiple accounts
runway deploy
```

Every declared workflow secret must exist before upload. Either export it during deploy or store it
on the repo Worker:

```sh
export LINEAR_WEBHOOK_SECRET=...
export LINEAR_API_KEY=...
export OPENROUTER_API_KEY=...
runway deploy
```

```sh
runway secrets set LINEAR_WEBHOOK_SECRET ...
runway secrets set LINEAR_API_KEY ...
runway secrets set OPENROUTER_API_KEY ...
runway deploy
```

`runway secrets set` uses the same repo-scoped script name as deploy. If the Worker does not exist,
it creates a placeholder Worker so the secret can be stored; `runway deploy` replaces it.

Deploy prints the repo script name and one URL per webhook trigger:

```text
Deployed 2 workflow(s) as runway-my-repo
  issue-review: POST https://runway-my-repo.<subdomain>.workers.dev/linear
```

Cron workflows do not print URLs; deploy updates the repo Worker's Cloudflare schedules.

## Triggers

Triggers are explicit. There is no default public start endpoint.

- `cron("0 9 * * *")` gives `event: { cron, scheduledTime }`.
- `webhook({ path, secret, signatureHeader, schema? })` is POST-only and verifies raw-body
  HMAC-SHA256.
- `webhook({ schema })` validates with Standard Schema and types `event` as the validation output.
  Validation failure returns `200 { skipped: true }` and starts no run.
- `webhook<T>(opts)` is assertion-only typing. `webhook(opts)` gives `unknown`.
- `.filter(typeGuard)` narrows and gates the event after schema validation.
- Multiple workflows may share one webhook path when secret, signature header, prefix, and timestamp
  config are identical. Each workflow still applies its own schema/filter gate.

Webhook responses are `202 { runs: [...] }` when a run starts, `200 { skipped: true }` when none do,
`401` for auth/timestamp failure, `400` for signed malformed JSON, and `500` for throwing trigger
evaluation.

## Secrets

Declare every workflow secret in `secrets`, including webhook signing secrets.

```ts
workflow({
  id: "issue-review",
  secrets: ["LINEAR_WEBHOOK_SECRET", "LINEAR_API_KEY", "OPENROUTER_API_KEY"],
  trigger: (ctx) =>
    webhook({
      path: "/linear",
      secret: ctx.secrets.LINEAR_WEBHOOK_SECRET,
      signatureHeader: "linear-signature",
    }),
});
```

In `trigger(ctx)`, `ctx.secrets.X` is a branded secret reference. In the handler, it is the runtime
string value. Deploy fails before upload when a declared secret is missing from both env and the repo
Worker. Env secrets upload as `secret_text` bindings and update matching Worker secrets. Secret names
cannot collide with Runway bindings: `WORKFLOWS`, `LOADER`, or `Sandbox`.

## Deploy Model

Runway deploys one Cloudflare orchestration Worker per repository, not one Worker per workflow. That
Worker owns webhook routing, cron routing, one `WORKFLOWS` binding, one `LOADER` binding, and the
Sandbox resources used by `ctx.agent` and `ctx.sandbox`.

Script naming is deterministic:

- `RUNWAY_SCRIPT_NAME`, if set.
- Otherwise package name, then directory basename.
- Repository-derived names are prefixed as `runway-<repo-slug>` unless already prefixed.

The same repo-scoped name is used for the Worker script, Dynamic Workflow resource, and workers.dev
host. Workflow `id` values are Runway routing ids inside that deployment.

`runway deploy` uses the typed Cloudflare SDK, not `wrangler deploy`. It bundles in memory, updates
the Worker, updates the matching Dynamic Workflow, replaces the cron schedule list, enables
workers.dev, and removes stale Workflow resources attached to the same script.

## Operational Limits

- Cloudflare is the only backend target.
- Target accounts need Workers, Workflows, Dynamic Workflows, Worker Loader, schedules, Sandbox, and
  Containers support.
- Webhooks are the public entrypoint; there is no manual-start HTTP endpoint.
- Step return values should be JSON-serializable and step bodies should be idempotent.
- `ctx.sleep` is named positionally within a run (`sleep-0`, `sleep-1`, ...), so keep sleep order
  stable.
- `ctx.agent` invokes `npx --yes @earendil-works/pi-coding-agent@0.79.1` inside Sandbox and inherits
  Cloudflare Sandbox/Container limits.
- Workflow resumes currently use the latest deployed workflow code and secrets. Version-pinned
  resumes are deferred until durable artifact storage and registry/control-plane work exist.

## Example

See [example/.runway/workflows/issue-review.ts](example/.runway/workflows/issue-review.ts) for the
dogfood Linear issue review workflow. It verifies a Linear webhook, narrows to created issues, runs
`ctx.agent`, and posts the review back with `@linear/sdk` inside `ctx.step`.

## Testing

- `pnpm typecheck`
- `pnpm lint`
- `pnpm format-check`
- `pnpm fallow`
- `pnpm test`
