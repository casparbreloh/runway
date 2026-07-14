# Runway

Runway is a TypeScript-first, general workflow framework on Cloudflare. Author workflows with
`workflow({ id, secrets?, trigger }).handler(async (ctx, event) => { ... })`, export them from
`.runway/workflows/**/*.ts`, and deploy them with `runway deploy`.

Repository execution and managed CI/CD are the first major use case. Runway will transport caches
for tools such as Turborepo and Nx rather than build its own dependency graph. Cloudflare Sandbox
will return as an internal runner implementation detail; agents are deferred. A future `step.ai()`
may use Cloudflare AI Gateway.

For product direction and non-goals, see [`.docs/VISION.md`](.docs/VISION.md).

## A Workflow

```ts
// .runway/workflows/hello.ts
import { cron, workflow } from "runway";

export default workflow({
  id: "hello",
  trigger: () => cron("0 9 * * *"),
}).handler(async (ctx, event) => {
  const greeting = await ctx.step.do("greet", () => "hello");
  await ctx.step.sleep("wait", 5000);
  await ctx.step.do("finish", () => `${greeting} world at ${event.scheduledTime}`);
});
```

Default exports, named exports, and barrel re-exports are supported. Handlers receive a typed
trigger event and this context:

```ts
interface Ctx {
  readonly runId: string;
  readonly secrets: Record<string, string>;
  readonly env: unknown;
  readonly step: {
    do<T>(id: string, fn: (ctx: StepContext) => T | Promise<T>): Promise<T>;
    sleep(id: string, durationMs: number): Promise<void>;
  };
}
```

Use `step.do()` for replayable work and `step.sleep()` for durable waits. Give every operation a
stable, explicit id, keep step bodies idempotent, and return JSON-serializable values.

## Quickstart

```sh
wrangler login
runway deploy
```

In CI, provide `CLOUDFLARE_API_TOKEN` and, when the token can see multiple accounts,
`CLOUDFLARE_ACCOUNT_ID`.

Every declared workflow secret must exist before upload. Export it during deploy or store it on the
repo Worker:

```sh
runway secrets set API_KEY ...
runway deploy
```

Deploy prints the repo script name and one URL per webhook trigger. Cron workflows do not print
URLs; deploy updates the repo Worker's Cloudflare schedules.

## Triggers

Triggers are explicit. There is no default public start endpoint.

- `cron("0 9 * * *")` gives `event: { cron, scheduledTime }`.
- `webhook({ path, secret, signatureHeader, schema? })` is POST-only and verifies raw-body
  HMAC-SHA256.
- `webhook({ schema })` validates with Standard Schema and types `event` as the validation output.
  Validation failure returns `200 { skipped: true }` and starts no run.
- `webhook<T>(opts)` is assertion-only typing. `webhook(opts)` gives `unknown`.
- `.filter(typeGuard)` narrows and gates the event after schema validation.
- Workflows may share a webhook path when their verification configuration is identical.

Webhook responses are `202` when a run starts, `200 { skipped: true }` when none do, `401` for
authentication or timestamp failure, `400` for signed malformed JSON, and `500` for throwing
trigger evaluation.

## Secrets

Declare every workflow secret in `secrets`, including webhook signing secrets. In `trigger(ctx)`,
`ctx.secrets.X` is a branded secret reference. In the handler it is the runtime string value.
Deploy fails before upload when a declared secret is missing from both the environment and the repo
Worker. Secret names cannot collide with the `WORKFLOWS` or `LOADER` bindings.

## Deploy Model

Runway deploys one orchestration Worker per repository. That Worker owns webhook and cron routing,
one Dynamic Workflows binding, and one Worker Loader binding. Per-workflow code is loaded through
Worker Loader and Dynamic Workflows.

`RUNWAY_SCRIPT_NAME` can set the deterministic repo-scoped name explicitly. Otherwise Runway uses
the package name, then the directory basename, normalized as a Cloudflare-compatible slug. The same
name identifies the Worker script, Dynamic Workflow resource, and workers.dev host.

`runway deploy` uses the Cloudflare SDK. It bundles in memory, uploads the Worker, updates its
Dynamic Workflow, replaces cron schedules, enables workers.dev, and removes stale Workflow
resources belonging to the same script.

## Scope

The current foundation includes workflows, triggers, secrets, routing, discovery, validation,
deployment, durable steps, and durable sleep. It does not yet include repository runners, caching,
GitHub integration, artifacts, application deployment primitives, AI, agents, or public Sandbox
access.

Cloudflare is the only backend target. Current deployments require Workers, Workflows, Dynamic
Workflows, Worker Loader, and schedules. Workflow resumes currently use the latest deployed code
and secrets.

## Example

See [example/.runway/workflows/daily-summary.ts](example/.runway/workflows/daily-summary.ts) for a
minimal scheduled workflow using `step.do()`.

## Testing

```sh
pnpm typecheck && pnpm lint && pnpm format-check && pnpm fallow && pnpm test
```
