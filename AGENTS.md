# Runway

TypeScript-first authoring over a language-neutral workflow and repository-runner foundation on
Cloudflare. Author workflows with
`workflow({ id, secrets?, trigger }).run(async (run, event) => { ... })` and export them from
`.runway/workflows/**/*.ts`.

Repository execution and managed CI/CD come first. Cloudflare Sandbox stays internally behind the
runner. Runway's generic filesystem cache transports caller-owned trees; later adapters may transport
tool-native caches for Turborepo, Nx, and other ecosystems. Foundation source contains no package-
manager, language-runtime, tool-preset, or dependency-graph semantics. Agents are deferred.

Read [`CONTEXT.md`](CONTEXT.md) before naming or moving a foundation boundary.

## Layout

- `packages/runway/` — SDK and `runway` CLI.
  - `src/secrets.ts` — secret references.
  - `src/workflow.ts` — `workflow()` and workflow contracts.
  - `src/trigger.ts` — webhook and cron triggers and contracts.
  - `src/github.ts` — GitHub trigger contracts and delivery normalization.
  - `src/registry.ts` — discovered workflow registry contracts and loading.
  - `src/run.ts` — public `Run`, command contracts, and durable operation wiring.
  - `src/cache.ts` — private generic cache identity, policy, refs, and publication.
  - `src/source.ts` — exact credential-free source identity and preparation evidence.
  - `src/sandbox.ts` — run-bound command and source lifecycle.
  - `src/cloudflare/sandbox.ts` — Cloudflare Sandbox process and checkout implementation.
  - `src/cloudflare/cache.ts` and `src/cloudflare/cache-snapshot.ts` — direct private transfer and
    safe schema-2 filesystem snapshots.
  - `src/terminal.ts` — one durable terminal winner and external terminal authority.
  - `src/meter.ts` — bounded latency, usage, provenance, and cost estimation.
  - `src/stack.ts` and `src/cloudflare/stack.ts` — exact desired resources and ownership receipts.
  - `src/runtime-binding.ts` — internal Worker RPC contract.
  - `src/runtime.ts` — workflow artifact runtime adapter.
  - `src/host-runtime.ts` — repo Worker host, artifact loading, routing, and runtime binding.
  - `src/workflow-artifact.ts` — immutable content-addressed artifact contract.
  - `src/secret-snapshot.ts` — encrypted durable run-secret snapshots.
  - `src/router.ts` — webhook and cron routing.
  - `src/deploy.ts` — validation and deployment orchestration.
  - `src/codegen.ts` — thin generated host configuration and workflow entry modules.
  - `src/validate.ts` — registry validation.
  - `tests/worker.test.ts` — Workers-runtime integration tests using Cloudflare's Vitest pool.
- `.runway/workflows/` — Runway's own GitHub-triggered `Check` and `Test` workflows.
- `.runway/repository.ts` — repository-only Node/pnpm consumer built from generic exec calls.

## Commands

- Full gate: `pnpm typecheck && pnpm lint && pnpm format-check && pnpm fallow && pnpm test`
- CLI: `runway deploy` and `runway secrets set`.

## Authoring Model

```ts
export default workflow({
  id: "check",
  trigger: () =>
    github({
      checkName: "Check",
      events: [
        { type: "push", branches: ["main"] },
        { type: "pull_request", actions: ["opened", "reopened", "synchronize"] },
      ],
    }),
}).run(async (run) => {
  await run.cache("dependencies", { key: { files: ["lockfile"] }, path: "/cache/dependencies" });
  await run.exec("install", "./scripts/install");
  await run.exec("check", "./scripts/check");
});
```

- Trigger is required and lives in the `workflow()` object.
- The callback receives `(run, event)`.
- `run` is `{ runId, secrets, do, exec, cache, sleep }`.
- Wrap HTTP and API calls in named `run.do()` calls.
- Use `run.exec(id, command)` for managed shell commands; options can set `cwd`, `env`, and
  `timeoutMs`.
- Use `run.cache(id, declaration)` before any command for one generic caller-owned filesystem tree.
  Foundation code must not infer package-manager, runtime, lockfile, or tool semantics.
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
- Trigger secrets are branded name references; run secrets are runtime strings.
- Deploy fails before upload when a declared secret is missing from env and the repo Worker.
- GitHub App bindings are `RUNWAY_GITHUB_APP_ID`, `RUNWAY_GITHUB_PRIVATE_KEY`, and
  `RUNWAY_GITHUB_WEBHOOK_SECRET`; they are internal and must not appear in workflow secrets.

## Runtime And Deployment

- Runway maps `run.do(id, fn)`, `run.exec(id, command)`, `run.cache(id, declaration)`, and
  `run.sleep(id, ms)` onto durable provider operations while keeping Cloudflare's step shape private.
- Command steps use deterministic process identities. Workflow retries reconnect to an existing
  running or completed process only when placement, process, and command digest prove continuity.
  Once a command may have started, unproven placement loss is terminal and never authorizes replay.
- Output is streamed incrementally and only redacted 64 KiB stdout/stderr tails are returned.
- Timeout and termination kill the command process group. Because Cloudflare rollback was `null`
  for a terminated active step in the live deployment smoke test, termination polling remains
  internal to the Cloudflare Sandbox implementation.
- The CLI discovers `.runway/workflows/**/*.ts`, excluding tests, specs, and type files.
- Default exports, named exports, and barrel re-exports are supported.
- Deploy stores each bundled workflow as one immutable content-addressed artifact in the shared
  account R2 bucket before uploading the host. Trigger starts persist only the artifact version;
  resumed Dynamic Workflows load that exact artifact.
- Declared secrets are captured once per run in an encrypted durable snapshot, so secret rotation
  does not alter an active run.
- `Stack` is the sole owner of one repo-scoped orchestration Worker, one Worker Loader binding, one
  matching Dynamic Workflow resource, the internal container and Durable Object namespaces,
  schedules/routes/bindings/secrets, exact owned objects, and one `RUNWAY_ARTIFACTS` binding to the
  private shared account artifact bucket. Sync/remove re-inventory exact provider state and preserve
  unknown or shared resources.
- Command steps lazily use one internal Cloudflare Sandbox workspace per workflow run and clean it
  up when the run ends. Deploy captures the repository remote and exact commit inside each workflow
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
- The deployed Stack is named exactly `runway` and uses the digest-pinned linux/amd64 image on
  `standard-4`. The legacy `runway-monorepo` Stack and public bootstrap bucket are deleted.
- Runway's root workflows intentionally use plain generic exec calls. Live evidence showed that
  transporting their whole toolchain, pnpm store, and `node_modules` trees costs more and runs slower
  than a clean install. The generic cache foundation remains available for consumers that prove a win.
- Cloudflare Artifacts is a possible future `Source` implementation only after repeated exact-revision
  latency and total-cost evidence wins. It is not the cache store.
- Deploy updates schedules, removes stale workflow resources for that script, enables workers.dev,
  waits for 31 consecutive cache-busted deployment identity observations over 30 seconds, and then
  returns webhook URLs, including one shared `/.runway/github` ingress when configured.
- Keep Sandbox and container deployment resources internal to the managed command implementation.
- Runway's own `Check` and `Test` workflows are the repository CI. At exact PR head `4f8f66f`, Check
  `87963050276` completed in 37 seconds provider-side and Test `87963048439` in 1m37s, with no cache
  operations. The duplicate GitHub Actions workflow is deleted; do not restore a fallback without a
  new explicit migration and evidence gate.

## Conventions

- Keep `.runway/workflows/` in the root TypeScript solution.
- Test behavior at the SDK, Workers runtime, CLI, and Cloudflare API seams. Do not test internal
  helpers or generated source strings directly.
- Code is effectively comment-free; add comments only for non-obvious rationale.
- Touch only the requested surface.
- Add catalog dependencies in `pnpm-workspace.yaml`; use `"catalog:"` in packages.
