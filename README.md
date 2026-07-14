# Runway

Runway is a TypeScript-first, general workflow framework on Cloudflare. Author workflows with
`workflow({ id, secrets?, trigger }).handler(async (ctx, event) => { ... })`, export them from
`.runway/workflows/**/*.ts`, and deploy them with `runway deploy`.

Repository execution and managed CI/CD are the first major use case. Runway executes commands in a
managed, run-scoped workspace and will transport caches for tools such as Turborepo and Nx rather
than build its own dependency graph. Cloudflare Sandbox remains an internal runner implementation
detail; agents are deferred. A future `step.ai()` may use Cloudflare AI Gateway.

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
  await ctx.step.exec("runtime", "node --version");
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
    exec(id: string, command: string | ExecOptions): Promise<ExecResult>;
    sleep(id: string, durationMs: number): Promise<void>;
  };
}
```

Use `step.do()` for replayable work, `step.exec()` for managed commands, and `step.sleep()` for
durable waits. Give every operation a stable, explicit id, keep step bodies idempotent, and return
JSON-serializable values.

```ts
await ctx.step.exec("install", "pnpm install --frozen-lockfile");
await ctx.step.exec("test", {
  command: "pnpm test",
  cwd: "packages/app",
  env: { NODE_ENV: "test" },
  timeoutMs: 20 * 60_000,
});
```

Commands default to `/workspace`, `CI=true`, and a 15-minute timeout. They never receive workflow
secrets automatically. Output streams to Worker logs with declared secret values redacted. The
returned `ExecResult` contains the exit code, duration, and at most 64 KiB each of redacted stdout
and stderr tail; a non-zero exit throws a secret-safe `ExecError`.

Each command has a deterministic process identity derived from its run and durable step. If
Cloudflare retries an active command step while its Sandbox survives, Runway reconnects to the
existing running or completed process instead of starting the command again. Timeout and Workflow
termination kill that process and its children. Sandbox restart loses both workspace state and the
process record, so cross-restart duplicate prevention is not yet part of the durability contract.

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
Worker. Secret names cannot collide with the `WORKFLOWS`, `LOADER`, or internal runner bindings.

## Deploy Model

Runway deploys one orchestration Worker per repository. That Worker owns webhook and cron routing,
one Dynamic Workflows binding, one Worker Loader binding, and an internal command-runner binding.
Per-workflow code is loaded through Worker Loader and Dynamic Workflows. The runner container starts
lazily on the first `step.exec()` in a run and is destroyed after workflow completion or failure.
The `/workspace` filesystem is ephemeral best-effort state: commands in one run reuse it, including
across `step.sleep()`, only while the same Sandbox container survives. A container restart loses the
workspace. Runway does not claim cross-restart durability.

Cloudflare Sandbox backup/restore is not enabled. It currently requires an R2 binding and production
presigning credentials, expired backup objects require separate lifecycle cleanup, and restored
mounts must themselves be restored again after a container restart. Until Runway can own that
lifecycle internally and prove acceptable CI overhead, repository checkout and cache transport
cannot rely on workspace persistence.

Cloudflare Workflow rollback cleans up ordinary failed runs, but a live deployment smoke test
returned `rollback: null` after terminating an active command. The internal runner adapter therefore
performs one termination-status check per second while a command is active; there is no separate
generated-code poller.

`RUNWAY_SCRIPT_NAME` can set the deterministic repo-scoped name explicitly. Otherwise Runway uses
the package name, then the directory basename, normalized as a Cloudflare-compatible slug. The same
name identifies the Worker script, Dynamic Workflow resource, and workers.dev host.

`runway deploy` uses the Cloudflare SDK. It bundles in memory, uploads the Worker, reconciles the
hidden Sandbox Durable Object and container application, updates its Dynamic Workflow, replaces
cron schedules, enables workers.dev, and removes stale Workflow resources belonging to the same
script.

## Scope

The current foundation includes workflows, triggers, secrets, routing, discovery, validation,
deployment, durable steps, durable sleep, and managed command execution. A live deployment smoke
test also covers workspace reuse across sleep, process-group timeout cleanup, and active-step
termination. It does not yet include
repository checkout, caching, GitHub integration, artifacts, application deployment primitives,
AI, agents, or public Sandbox access.

Cloudflare is the only backend target. Current deployments require Workers, Workflows, Dynamic
Workflows, Worker Loader, and schedules. Workflow resumes currently use the latest deployed code
and secrets.

## Example

See [example/.runway/workflows/daily-summary.ts](example/.runway/workflows/daily-summary.ts) for a
minimal scheduled workflow using `step.do()` and `step.exec()`.

## Testing

Worker and Workflow integration tests run locally inside `workerd` through Cloudflare's Vitest
integration. The suite tests public SDK, Workers runtime, generated runner adapter, CLI, and
Cloudflare API boundaries. Sandbox restart is simulated at that seam; cross-restart filesystem
durability has not been proven live and is not part of the contract.

```sh
pnpm typecheck && pnpm lint && pnpm format-check && pnpm fallow && pnpm test
```
