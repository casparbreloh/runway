# Runway

Runway is a TypeScript-first, general workflow framework on Cloudflare. Author workflows with
`workflow({ id, secrets?, trigger }).run(async (run, event) => { ... })`, export them from
`.runway/workflows/**/*.ts`, and deploy them with `runway deploy`.

Repository execution and managed CI/CD are the first major use case. Runway executes commands in a
managed, run-scoped workspace and will transport caches for tools such as Turborepo and Nx rather
than build its own dependency graph. Cloudflare Sandbox remains an internal runner implementation
detail; agents are deferred. A future `run.ai()` may use Cloudflare AI Gateway.

For product direction and non-goals, see [`.docs/VISION.md`](.docs/VISION.md).

## A Workflow

```ts
// .runway/workflows/hello.ts
import { cron, workflow } from "runway";

export default workflow({
  id: "hello",
  trigger: () => cron("0 9 * * *"),
}).run(async (run, event) => {
  const greeting = await run.do("greet", () => "hello");
  await run.exec("runtime", "node --version");
  await run.sleep("wait", 5000);
  await run.do("finish", () => `${greeting} world at ${event.scheduledTime}`);
});
```

Default exports, named exports, and barrel re-exports are supported. Run callbacks receive a typed
trigger event and this interface:

```ts
interface Run {
  readonly runId: string;
  readonly secrets: Record<string, string>;
  do<T>(id: string, work: () => T | Promise<T>): Promise<T>;
  exec(id: string, command: string | ExecOptions): Promise<ExecResult>;
  sleep(id: string, durationMs: number): Promise<void>;
}
```

Use `run.do()` for replayable work, `run.exec()` for managed commands, and `run.sleep()` for
durable waits. Give every operation a stable 1–128 byte id, keep operation bodies idempotent, and return
JSON-serializable values.

```ts
await run.exec("install", "pnpm install --frozen-lockfile");
await run.exec("test", {
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
URLs; deploy updates the repo Worker's Cloudflare schedules. A deployment containing GitHub
triggers prints one shared `github` URL ending in `/.runway/github`.

## Triggers

Triggers are explicit. There is no default public start endpoint.

- `cron("0 9 * * *")` gives `event: { cron, scheduledTime }`.
- `github({ checkName, events })` selects pushes by branch and pull requests by action. Push events
  provide the exact pushed SHA; pull-request events provide the exact head SHA. Runway verifies the
  GitHub App delivery, starts the matching workflows, and owns their GitHub Check lifecycle.
- `webhook({ path, secret, signatureHeader, schema? })` is POST-only and verifies raw-body
  HMAC-SHA256.
- `webhook({ schema })` validates with Standard Schema and types `event` as the validation output.
  Validation failure returns `200 { skipped: true }` and starts no run.
- `webhook<T>(opts)` is assertion-only typing. `webhook(opts)` gives `unknown`.
- `.filter(typeGuard)` narrows and gates the event after schema validation.
- Workflows may share a webhook path when their verification configuration is identical.

Webhook responses are `202` when work is admitted, `200 { skipped: true }` when none do, `401` for
authentication or timestamp failure, `400` for signed malformed JSON, and `500` for throwing
trigger evaluation. GitHub deliveries are deduplicated for seven days and dispatched from a durable
outbox after the ingress response.

## Secrets

Declare every workflow secret in `secrets`, including webhook signing secrets. In `trigger(ctx)`,
`ctx.secrets.X` is a branded secret reference. In the run callback it is the runtime string value.
Deploy fails before upload when a declared secret is missing from both the environment and the repo
Worker. Secret names cannot collide with the `WORKFLOWS`, `LOADER`, or internal runner and GitHub
bindings.

GitHub triggers use three internal App bindings rather than authored workflow secrets:
`RUNWAY_GITHUB_APP_ID`, `RUNWAY_GITHUB_PRIVATE_KEY`, and `RUNWAY_GITHUB_WEBHOOK_SECRET`. The private
key may be GitHub's generated PKCS#1 PEM or a PKCS#8 PEM. These values are available to deployment
and the managed runtime only; run callbacks and run-secret snapshots never receive them.

## Deploy Model

Runway deploys one orchestration Worker per repository. That Worker owns webhook and cron routing,
one Dynamic Workflows binding, one Worker Loader binding, an internal command-runner binding, and a
repo-scoped coordinator whose instances are used only for GitHub triggers. Per-workflow code is loaded through
Worker Loader and Dynamic Workflows. The runner container starts lazily on the first `step.exec()` in
a run and is destroyed after workflow completion or failure.

Deploy captures `origin` and exact `HEAD` inside each immutable workflow artifact. Public remotes
remain unauthenticated. For a GitHub remote with App credentials, deploy resolves and stores only
its stable repository and installation identity. A verified GitHub delivery overrides the artifact
source with its exact run repository and SHA. Before the first command, the runner reconstructs that
commit in `/workspace`. Commands in one run reuse the checkout, including across `step.sleep()`. If
a fresh Sandbox no longer contains the matching checkout marker, the runner reconstructs the same
commit before the next command and mints a new repository-scoped installation token when needed.
Tokens travel only through the checkout process environment and are redacted from managed output.

Cloudflare Sandbox backup/restore is not enabled. It currently requires an R2 binding and production
presigning credentials, expired backup objects require separate lifecycle cleanup, and restored
mounts must themselves be restored again after a container restart. Repository source therefore
uses deterministic reconstruction rather than filesystem persistence.

This repository bootstraps its Linux CI toolchain and lockfile-resolved dependencies from a
reproducible, content-addressed archive in a dedicated public R2 cache bucket. Each archive chunk
and the complete archive are SHA-256 verified before extraction. That bucket contains only the
toolchain and dependency tree: workflow artifacts, repository source, run data, and credentials
remain in private storage. This bootstrap is specific to Runway's own workflows; general cache
transport through tools such as Turborepo and Nx remains a later milestone.

Cloudflare Workflow rollback cleans up ordinary failed runs, but a live deployment smoke test
returned `rollback: null` after terminating an active command. The internal runner adapter therefore
performs one termination-status check per second while a command is active; there is no separate
generated-code poller.

`RUNWAY_SCRIPT_NAME` can set the deterministic repo-scoped name explicitly. Otherwise Runway uses
the package name, then the directory basename, normalized as a Cloudflare-compatible slug. The same
name identifies the Worker script, Dynamic Workflow resource, and workers.dev host.

`runway deploy` uses the Cloudflare SDK. It bundles in memory, uploads the Worker, reconciles the
hidden Sandbox and GitHub coordinator Durable Objects and container application, updates its
Dynamic Workflow, replaces cron schedules, enables workers.dev, and removes stale Workflow
resources belonging to the same script. The managed runner uses Cloudflare's `standard-1`
container tier. When deployment changes an existing container definition, Runway explicitly starts
the required rollout and waits for it to complete; updating application metadata alone does not
activate the new runner configuration.

## GitHub App Setup

Create a GitHub App named Runway for the repository integration. It needs Contents read, Pull
requests read, and Checks write permissions, and subscriptions to Push and Pull request events.
Install it only on the repository being deployed. Set its webhook secret to the same value as
`RUNWAY_GITHUB_WEBHOOK_SECRET`; after the first deploy, set the App webhook URL to the printed
`github` URL.

Provide the App ID and private key locally for every deploy. Provide the webhook secret locally for
the first deploy, or store it on the repo Worker for later preservation:

```sh
export RUNWAY_GITHUB_APP_ID=12345
export RUNWAY_GITHUB_PRIVATE_KEY="$(cat /path/to/github-app.pem)"
export RUNWAY_GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
runway deploy
```

The root [Check](.runway/workflows/check.ts) and [Test](.runway/workflows/test.ts) workflows run for
pushes to `main` and pull requests opened, reopened, or synchronized. This evidence-gated cutover
makes Runway the repository's CI provider by deleting the duplicate GitHub Actions workflow.

The cutover was gated by live evidence on 2026-07-16. The installed App, `Runway by casparbreloh`,
accepted delivery `4ce375d0-812e-11f1-8d6c-4c67fc189943` for exact PR head
`cc86fa5820f78d7dfce15cb2ffbc6507d03bccfb`. Generation 42 completed Check
`87671213580` and Test `87671211046` successfully, with Runway external IDs ending in `-42`.
Supersession cancelled generation 34 Check `87638027646` and Test `87638030943`, while unrelated
Actions checks remained successful. An authenticated recovery run checked out exact SHA
`8c63b9a00f7a15c8ed66eaad1dba33730609dfe4`, changed Sandbox placement after `Sandbox.destroy()`,
reminted repository-scoped authentication, reused the recovered placement for the next command,
kept credentials out of diagnostics, and left no owned smoke resources. The `main` branch was
unprotected, so the cutover required no branch-rule migration.

## Scope

The current implementation includes workflows, triggers, secrets, routing, discovery, validation,
deployment, durable steps, durable sleep, immutable workflow artifacts, authenticated private GitHub
checkout, GitHub delivery dispatch and Checks, scoped supersession, and managed command execution.
Public and authenticated repository recovery and the complete GitHub self-hosting flow have
repeatable live evidence. Runway does not yet include general-purpose cache transport, run
artifacts, application deployment primitives, AI, agents, or public Sandbox access.

Cloudflare is the only backend target. Current deployments require Workers, Workflows, Dynamic
Workflows, Worker Loader, and schedules. Workflow resumes load their exact immutable workflow
artifact and durable run-secret snapshot.

## This Repository's Workflows

Runway dogfoods its authoring model through [`.runway/workflows/`](.runway/workflows). These files
are part of the root TypeScript solution, so ordinary `pnpm typecheck` verifies them.

## Testing

Worker and Workflow integration tests run locally inside `workerd` through Cloudflare's Vitest
integration. The suite tests public SDK, Workers runtime, generated runner adapter, CLI, and
Cloudflare API boundaries. Repeatable live smokes also prove public and authenticated exact-SHA
repository reconstruction after forced Sandbox replacement and audit their owned-resource cleanup.

```sh
pnpm typecheck && pnpm lint && pnpm format-check && pnpm fallow && pnpm test
```
