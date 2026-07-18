# Runway

Runway is a TypeScript-first authoring layer over a language-neutral workflow and repository-runner
foundation on Cloudflare. Author workflows with
`workflow({ id, secrets?, tools?, trigger }).run(async (step, event) => { ... })`, export them from
`.runway/workflows/**/*.ts`, and deploy them with `runway deploy`.

Repository execution and managed CI/CD come first. Cloudflare Sandbox, cache transport, credentials,
terminal coordination, metering, and resource reconciliation stay internal. Runway does not own a
package-manager preset, dependency graph, build scheduler, or public Sandbox API. Agents are deferred.

This project is in development, not production. The foundation is deployed for its own repository CI;
comparative release claims and publication remain gated. See [Development Status](#development-status).

For the domain vocabulary see [`CONTEXT.md`](CONTEXT.md). For direction and non-goals see
[`.docs/VISION.md`](.docs/VISION.md).

## A Workflow

```ts
// .runway/workflows/hello.ts
import { cron, mise, workflow } from "runway";

export default workflow({
  id: "hello",
  tools: mise(),
  trigger: () => cron("0 9 * * *"),
}).run(async (step, event) => {
  await step.cache("runtime", {
    key: { prefix: "runtime-linux-", files: ["runtime.lock"] },
    restoreKeys: ["runtime-linux-"],
    paths: ["/cache/runtime", ".runtime"],
  });
  const greeting = await step.do("greet", () => "hello");
  await step.exec("check", "./scripts/check");
  await step.sleep("wait", 5000);
  await step.do("finish", () => `${greeting} world at ${event.scheduledTime}`);
});
```

Default exports, named exports, and barrel re-exports are supported. The run callback receives the
typed trigger event and one flat author surface:

```ts
interface Step<Secrets extends string = string> {
  readonly runId: string;
  readonly secrets: { readonly [Name in Secrets]: string };
  do<T>(id: string, work: () => T | Promise<T>): Promise<T>;
  exec(id: string, command: string | ExecOptions): Promise<ExecResult>;
  cache(id: string, declaration: CacheDeclaration): Promise<CacheResult>;
  sleep(id: string, durationMs: number): Promise<void>;
}
```

Use `step.do()` for replayable work, `step.exec()` for managed commands, `step.cache()` for generic
filesystem trees, and `step.sleep()` for durable waits. Give every operation a stable 1–128 UTF-8 byte
id that does not begin with `runway:`. Durable operation bodies must be idempotent and return
JSON-serializable values.

```ts
await step.exec("check", {
  command: "./scripts/check",
  cwd: "packages/app",
  env: { MODE: "ci" },
  timeoutMs: 20 * 60_000,
});
```

Commands default to `/workspace`, `CI=true`, and a 15-minute timeout. They do not receive workflow
secrets automatically. A non-zero exit throws a secret-safe `ExecError`; the result and diagnostics
contain bounded, redacted output tails.

## Exact Source And Continuity

Every repository run binds a credential-free HTTPS remote to an exact 40-character Git revision.
The Sandbox prepares `/workspace` lazily and verifies `HEAD`. Private GitHub checkout uses a
repository-scoped installation token only in the checkout process environment; the token is removed
before authored commands and never becomes Source evidence.

One Sandbox belongs to one run and exact Source. A retry may reconnect only when placement, process,
and command digest prove continuity. If a Sandbox is replaced before any command may have started,
Runway can reconstruct the same Source. Once a command has started or may have started, unproven
placement loss fails the run instead of replaying possible filesystem or external side effects.
Caches do not change this rule and are not workspace checkpoints.

## Tools And Generic Cache

Mise is the common-case provider. It discovers repository configuration by default, or accepts a
small inline tool map. Its pinned mise binary, installed tools, shims, and required runtime files are
cached automatically:

```ts
tools: mise();
tools: mise({ node: "26.5.0", pnpm: "11.5.0" });
```

Providers are ordered, so a workflow can mix mise with a native release or a provider built with
`defineToolProvider()`:

```ts
workflow({
  id: "check",
  tools: [
    mise(),
    release({
      name: "aube",
      version: "1.2.3",
      url: "https://example.com/aube-1.2.3-linux-amd64.tar.gz",
      sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      executable: "aube",
    }),
  ],
  trigger: () => cron("0 9 * * *"),
}).run(async (step) => {
  await step.exec("check", "aube check");
});
```

`step.cache()` declares caller-owned trees before command execution:

```ts
const result = await step.cache("compiler-state", {
  key: { prefix: "compiler-linux-", files: ["compiler.lock", "project.json"] },
  restoreKeys: ["compiler-linux-"],
  paths: ["/cache/compiler-state", ".compiler"],
});
```

The foundation knows paths, content keys, platform identity, trust, integrity, and budgets. It knows
nothing about pnpm, Python, Rust, or any other ecosystem. Relative targets resolve below
`/workspace`; absolute targets are restricted to safe roots below `/workspace` or `/cache`. Cache
restore happens before any command. A cache may be published only after the durable terminal winner
is success; failed, cancelled, superseded, unsafe, corrupt, or over-budget producers do not advance a
ref.

Payloads are private, content-addressed SquashFS objects transferred directly between the Sandbox
and R2 through short-lived exact-object capabilities. Restore verifies identity and integrity in a
sibling staging tree before an atomic rename. Cache schema 2 and runner ABI
`runway-sandbox-v2` append a bounded canonical private hardlink trailer to preserve regular-file
identity with the pinned image's high-level `squashfuse`. This is private encoding, not a public
snapshot or content-store API.

The foundation includes safe restore and success-only publication behavior. Live private-R2 runs
proved miss, publication, warm restore, and corrupt-input handling. Runway keeps cache use
evidence-driven: its own repository removed whole-tree caches after they lost on both latency and cost.

## Triggers And Secrets

Triggers are explicit; there is no default public start endpoint.

- `cron("0 9 * * *")` gives `event: { cron, scheduledTime }`.
- `github({ checkName, events })` selects pushes and pull requests, binds each accepted delivery to
  its exact repository and SHA, and keeps the GitHub Checks lifecycle internal.
- `webhook({ path, secret, signatureHeader, schema? })` verifies the raw POST body with HMAC-SHA256.
- `webhook({ path, secret, signatureHeader, schema })` validates with Standard Schema and types the
  event as its output.
- `webhook<T>({ path, secret, signatureHeader })` is assertion-only typing; the same required options
  without a generic give `unknown`.
- `.filter(typeGuard)` narrows and gates a trigger event after validation.

Declare every workflow secret, including webhook signing secrets. In `trigger(ctx)`,
`ctx.secrets.X` is a branded name reference; in the run callback, `step.secrets.X` is the captured
runtime string. Deploy fails before upload when a declared secret is missing.

GitHub triggers use internal `RUNWAY_GITHUB_APP_ID`, `RUNWAY_GITHUB_PRIVATE_KEY`, and
`RUNWAY_GITHUB_WEBHOOK_SECRET` bindings. They never enter authored workflow secrets or repository
commands.

## Deployment And Stack Ownership

`runway deploy` discovers `.runway/workflows/**/*.ts`, builds immutable content-addressed workflow
artifacts, and creates one repo-scoped Cloudflare Stack. A Stack manifest and immutable receipt bind
the exact Worker version/deployment, Dynamic Workflow, container image and rollout, Durable Object
namespaces, schedules, routes, bindings, secret names, workers.dev state, and exact owned bucket
objects. Sync and removal re-inventory the provider and fail closed on drift. Unknown state and shared
objects are preserved.

The private `runway-data` and `runway-state` buckets are shared by the account; Stack removal must
preserve them and any object not claimed by exact ownership evidence. A deployment name is derived
from the Git repository: `runway` for this repository and `runway-<repository>` otherwise. Its
Worker, Dynamic Workflow, and container use that exact name; its Durable Object namespaces append
`-github` and `-sandbox`. The digest-pinned linux/amd64 Sandbox uses `standard-4`. Capacity remains an
internal foundation choice, not a public workflow option.

```sh
wrangler login
runway deploy
```

In CI, provide `CLOUDFLARE_API_TOKEN` and, when needed, `CLOUDFLARE_ACCOUNT_ID`. Set authored secrets
with `runway secrets set NAME ...`. `package.json` cannot configure Runway. `RUNWAY_NAME` is reserved
for isolated deployments such as live smokes and must be `runway` or begin with `runway-`.

## GitHub App Setup

Create a GitHub App named Runway with Contents read, Pull requests read, Checks write, and Push and
Pull request subscriptions. Install it only on repositories Runway should serve. Set its webhook URL
to the deployed `/.runway/github` endpoint and use the same webhook secret as
`RUNWAY_GITHUB_WEBHOOK_SECRET`.

```sh
export RUNWAY_GITHUB_APP_ID=12345
export RUNWAY_GITHUB_PRIVATE_KEY="$(cat /path/to/github-app.pem)"
export RUNWAY_GITHUB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
runway deploy
```

## Development Status

The root [Check](.runway/workflows/check.ts) and [Test](.runway/workflows/test.ts) workflows are
ordinary Runway consumers. They use the mise provider for Node and pnpm; provider-owned tool caches
remain adapters over the same generic cache foundation.

At PR head `df10a82` on 2026-07-17, 15 sequential development samples on the deployed `runway`
integration produced Check P50/P95 of 39s/46s, Test P50/P95 of 87s/102s, and delivery-to-terminal
P50/P95 of 96s/105s, with no cache operations. The earlier whole-tree cache experiment took
2m23s/3m25s cold and 3m28s/4m14s warm, plus about $0.013 of cache work per warm run, so it was
removed rather than abstracted into the foundation.

The exact `runway` Stack runs the digest-pinned linux/amd64 Sandbox on `standard-4`.

Runway's Check/Test workflows are the only repository CI. Do not add a duplicate GitHub Actions
fallback.

## Scope

Implemented locally: workflow authoring, triggers, secrets, exact Source, durable operations,
run-bound Sandbox execution, one Terminal authority, generic cache identity/restore/publication,
Meter quantities, immutable workflow artifacts, GitHub delivery and Checks coordination, and exact
Stack ownership/reconciliation.

Still intentionally deferred: comparative release benchmarking, ecosystem-specific application cache adapters, and final
publication. Cloudflare Artifacts is a future evidence-gated Source implementation only; it is not the
cache store. BuildKit, run artifacts, deployment workflows, AI, and agents are later consumers.

## Testing

Tests cover public SDK, Workers runtime, CLI, cache safety, and Cloudflare API seams. Run the full
gate with:

```sh
pnpm typecheck && pnpm lint && pnpm format-check && pnpm fallow && pnpm test
```
