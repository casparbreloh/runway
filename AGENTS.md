# Runway

TypeScript-first authoring over a language-neutral workflow and repository-runner foundation on
Cloudflare. Author workflows with
`workflow({ id, secrets?, tools?, trigger? }).run(async (step, event) => { ... })` and export them from
`.runway/workflows/**/*.ts`.

Repository execution and managed CI/CD come first. Cloudflare Sandbox stays internally behind the
runner. Runway's generic filesystem cache transports caller-owned trees; later adapters may transport
tool-native caches for Turborepo, Nx, and other ecosystems. Foundation source contains no package-
manager, language-runtime, or dependency-graph semantics. Tool providers are thin adapters over
generic cache and exec; agents are deferred.

Read [`VISION.md`](VISION.md) before naming or moving a foundation boundary.

## Layout

- `packages/runway/` — SDK and `runway` CLI.
  - Keep the author-facing modules flat in `src/`; `runtime.ts` is the intentional host-only
    package subpath.
  - Put substantial private domains in singular `src/internal/<domain>/` folders. A folder should
    contain multiple collaborating implementations behind one small interface; otherwise keep the
    implementation in one file.
  - Prefer singular, responsibility-based filenames. Split for a real runtime, adapter, dependency,
    or invariant seam—not line count—and merge shallow helpers into the module that owns them.
  - Tests attach to public or deep internal interfaces and carry behavior across implementations;
    do not create one test file per source file or test private helpers directly.
- `.runway/workflows/` — Runway's own GitHub-triggered `Check` and `Test` workflows.

## Commands

Mise automatically installs the locked Node and Aube tools and reconciles Aube dependencies when a
task runs.

- Full gate: `mise run format-check`, `mise run lint`, `mise run typecheck`, `mise run fallow`, and
  `mise run test`.
- Opt-in deep suite: `mise run test:deep` runs the exact pinned-image cache contract and live
  Cloudflare recovery smokes sequentially. It requires privileged Docker with linux/amd64 support,
  Cloudflare authentication, and R2 S3 credentials; it is not part of routine CI.
- CLI: `runway init`, local `runway run <id> [--event <file|->]`, and `runway secrets set`; cloud
  execution and GitHub connection commands are still being implemented.

## Authoring Model

```ts
export default workflow({
  id: "check",
  tools: mise(),
  trigger: () =>
    github({
      checkName: "Check",
      events: [
        { type: "push", branches: ["main"] },
        { type: "pull_request", actions: ["opened", "reopened", "synchronize"] },
      ],
    }),
}).run(async (step) => {
  await step.cache("dependencies", {
    key: { prefix: "dependencies-linux-", files: ["lockfile"] },
    restoreKeys: ["dependencies-linux-"],
    paths: ["/cache/dependencies"],
  });
  await step.exec("install", "./scripts/install");
  await step.exec("check", "./scripts/check");
});
```

- Trigger is optional. Omitting it creates a workflow with no automatic ingress and an `undefined`
  event.
- The callback receives `(step, event)`.
- `step` is `{ runId, secrets, do, exec, cache, sleep }`.
- Wrap HTTP and API calls in named `step.do()` calls.
- Use `step.exec(id, command)` for managed shell commands; options can set `cwd`, `env`, and
  `timeoutMs`.
- Use `step.cache(id, declaration)` before any command for generic caller-owned filesystem trees.
  Foundation code must not infer package-manager, runtime, lockfile, or tool semantics.
- `tools: mise()` discovers repository config; `mise({ ... })` defines inline tools. Providers may
  use the generic cache when transport is demonstrably cheaper than setup. Ordered arrays support
  mixed providers without a registry.
- Durable operation return values must be JSON-serializable and operation bodies idempotent.
- Every sleep has a caller-provided stable id.
- Caller-provided operation ids are 1–128 UTF-8 bytes and must not begin with `runway:`.

## Triggers And Secrets

- `webhook({ path, secret, signatureHeader, schema })` validates with Standard Schema and types the
  event as its output.
- `webhook<T>({ path, secret, signatureHeader })` is assertion-only typing; the same required options
  without a generic give `unknown`.
- `.filter(typeGuard)` narrows the event and returns a new trigger.
- `cron(expression)` types the event as `{ cron, scheduledTime }`.
- `github({ checkName, events })` types normalized push and pull-request events and keeps App
  signatures, installation IDs, credentials, and Checks internal.
- Declare every workflow secret, including webhook signing secrets.
- Trigger secrets are branded name references; step secrets are runtime strings.
- Internal publication fails before upload when a declared secret is missing from env and the repo Worker.
- GitHub App bindings are `RUNWAY_GITHUB_APP_ID`, `RUNWAY_GITHUB_PRIVATE_KEY`, and
  `RUNWAY_GITHUB_WEBHOOK_SECRET`; they are internal and must not appear in workflow secrets.

## Runtime And Deployment

- Runway maps `step.do(id, fn)`, `step.exec(id, command)`, `step.cache(id, declaration)`, and
  `step.sleep(id, ms)` onto durable provider operations while keeping Cloudflare's step shape private.
- Command steps use deterministic process identities. Workflow retries reconnect to an existing
  running or completed process only when placement, process, and command digest prove continuity.
  Once a command may have started, unproven placement loss is terminal and never authorizes replay.
- Output is streamed incrementally and only redacted 64 KiB stdout/stderr tails are returned.
- Timeout and termination kill the command process group. Because Cloudflare rollback was `null`
  for a terminated active step in the live deployment smoke test, termination polling remains
  internal to the Cloudflare Sandbox implementation.
- The CLI discovers `.runway/workflows/**/*.ts`, excluding tests, specs, and type files.
- Default exports, named exports, and barrel re-exports are supported.
- Internal publication stores each bundled workflow as one immutable content-addressed artifact in the shared
  account R2 bucket before uploading the host. Trigger starts persist only the artifact version;
  resumed Dynamic Workflows load that exact artifact.
- Declared secrets are captured once per run in an encrypted durable snapshot, so secret rotation
  does not alter an active run.
- `Stack` is the sole owner of one repo-scoped orchestration Worker, one Worker Loader binding, one
  matching Dynamic Workflow resource, the internal container and Durable Object namespaces,
  schedules/routes/bindings/secrets, exact owned objects, and one `RUNWAY_DATA` binding to the
  private shared account artifact bucket. Sync/remove re-inventory exact provider state and preserve
  unknown or shared resources.
- Command steps lazily use one internal Cloudflare Sandbox workspace per workflow run and clean it
  up when the run ends. Internal publication captures the repository remote and exact commit inside each workflow
  artifact. GitHub deliveries provide an exact run source. Private checkout uses a purpose-scoped,
  repository-scoped installation token only in the checkout process environment. The Sandbox
  prepares `/workspace` before the first command and reconstructs the same commit, reminting when
  needed, after a fresh Sandbox loses its matching marker.
- Repository recovery is deterministic reconstruction, not Sandbox workspace checkpointing. The
  Workers-runtime seam and repeatable public and authenticated live `Sandbox.destroy()` smokes
  cover forced replacement. Sandbox backup/restore still needs R2 credentials/configuration and
  object lifecycle management, so Runway does not enable a partial checkpoint layer.
- Cache schema 2 and runner ABI `runway-sandbox-v2` use private content-addressed SquashFS objects
  with a bounded canonical hardlink trailer. Restore is staged and integrity-checked; only the
  durable winning success may publish. Cache is not Source, a checkpoint, or a public content store.
- A Stack derives one name from its Git repository. Its Worker, Dynamic Workflow, and container share
  that name. Cloudflare derives its Durable Object namespace names from the Worker and class names.
  Account data and state use the shared `runway-data` and `runway-state` buckets. The digest-pinned
  linux/amd64 image runs on `standard-4`.
- Runway's root workflows discover the repository mise configuration for Node and Aube and run
  ordinary mise tasks that automatically reconcile dependencies, without caching application
  dependency installation. Earlier pnpm-era evidence showed that transporting the pnpm store and
  `node_modules` costs more and runs slower than a clean install.
- Cloudflare Artifacts is a possible future `Source` implementation only after repeated exact-revision
  latency and total-cost evidence wins. It is not the cache store.
- Internal publication updates schedules, removes stale workflow resources for that script, enables workers.dev,
  waits for 31 consecutive cache-busted deployment identity observations over 30 seconds, and then
  returns webhook URLs, including one shared `/.runway/github` ingress when configured.
- Keep Sandbox and container deployment resources internal to the managed command implementation.
- Runway's own `Check` and `Test` workflows are the repository CI. At exact PR head `df10a82`, 15
  sequential development samples produced Check P50/P95 of 39s/46s and Test P50/P95 of 87s/102s,
  with no cache operations. Do not add a duplicate GitHub Actions fallback.

## Conventions

- Runway is pre-1.0. Do not preserve backward compatibility unless explicitly requested. Prefer the
  simplest current design: remove obsolete commands, aliases, migrations, compatibility branches,
  deleted-feature tests, and stale documentation instead of carrying the old state forward.
- Keep `.runway/workflows/` in the root TypeScript solution.
- Test behavior at the SDK, Workers runtime, CLI, and Cloudflare API seams. Do not test internal
  helpers or generated source strings directly.
- Code is effectively comment-free; add comments only for non-obvious rationale.
- Touch only the requested surface.
- Manage dependency changes with Aube, update catalogs in `aube-workspace.yaml`, and run
  `mise deps`; package manifests retain `"catalog:"` and `"workspace:*"` protocols.
