# Runway

TypeScript-first general workflow infrastructure for custom triggers, scheduled work, webhooks, and
repository automation on Cloudflare. Author workflows with
`workflow({ id, secrets?, trigger }).run(async (run, event) => { ... })` and export them from
`.runway/workflows/**/*.ts`.

Repository execution and managed CI/CD come first. Cloudflare Sandbox stays internally behind the
runner. Runway will transport caches for tools such as Turborepo and Nx rather than build its
own dependency graph. A future `run.ai()` may use Cloudflare AI Gateway. Agents are deferred.

## Layout

- `packages/runway/` — SDK and `runway` CLI.
  - `src/types.ts` — public contracts.
  - `src/secrets.ts` — secret references.
  - `src/workflow.ts` — `workflow()`.
  - `src/trigger.ts` — webhook and cron triggers.
  - `src/run.ts` — public `Run`, command contracts, and durable operation wiring.
  - `src/sandbox.ts` — run-bound command and source lifecycle.
  - `src/cloudflare/sandbox.ts` — Cloudflare Sandbox process and checkout implementation.
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
- `.runway/ci.ts` and `.runway/cache/Dockerfile` — verified content-addressed bootstrap for those
  workflows' Linux toolchain and lockfile-resolved dependencies.

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
  await run.exec("install", "pnpm install --frozen-lockfile");
  await run.exec("typecheck", "pnpm typecheck");
});
```

- Trigger is required and lives in the `workflow()` object.
- The callback receives `(run, event)`.
- `run` is `{ runId, secrets, do, exec, sleep }`.
- Wrap HTTP and API calls in named `run.do()` calls.
- Use `run.exec(id, command)` for managed shell commands; options can set `cwd`, `env`, and
  `timeoutMs`.
- Durable operation return values must be JSON-serializable and operation bodies idempotent.
- Every sleep has a caller-provided stable id.
- Caller-provided operation ids are 1–128 UTF-8 bytes and must not begin with `runway:`.

## Triggers And Secrets

- `webhook({ schema })` validates with Standard Schema and types the event as its output.
- `webhook<T>(opts)` is assertion-only typing; `webhook(opts)` gives `unknown`.
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

- Runway maps `run.do(id, fn)` to Cloudflare `step.do(id, fn)`, `run.exec(id, command)` to a durable,
  run-scoped managed command step, and `run.sleep(id, ms)` to `step.sleep(id, ms)`.
- Command steps use deterministic process identities. Workflow retries reconnect to an existing
  running or completed process while the same Sandbox survives instead of starting it again.
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
- Runway owns one repo-scoped orchestration Worker, one Worker Loader binding, one matching Dynamic
  Workflow resource, one `RUNWAY_ARTIFACTS` binding to the shared account artifact bucket, and a
  repo-scoped GitHub coordinator whose instances are used only when GitHub triggers are present.
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
- The managed Sandbox uses the `standard-1` container tier. Reconciliation of an existing container
  definition must explicitly create and verify its rollout; a successful metadata update does not
  activate changed Sandbox capacity by itself.
- Runway's root workflows fetch a reproducible content-addressed CI bootstrap from a dedicated
  public R2 bucket. Verify each chunk and the complete archive before extraction. Only the Linux
  toolchain and lockfile-resolved dependencies are public; keep artifacts, source, run data, and
  credentials in private storage. This bootstrap does not replace the future Turborepo/Nx cache
  transport milestone.
- Deploy updates schedules, removes stale workflow resources for that script, enables workers.dev,
  waits for 31 consecutive cache-busted deployment identity observations over 30 seconds, and then
  returns webhook URLs, including one shared `/.runway/github` ingress when configured.
- Keep Sandbox and container deployment resources internal to the managed command implementation.
- Runway's own `Check` and `Test` workflows are the repository CI. The live evidence gate passed,
  and this cutover deletes the duplicate GitHub Actions workflow; do not restore it without a new
  explicit migration.

## Conventions

- Keep `.runway/workflows/` in the root TypeScript solution.
- Test behavior at the SDK, Workers runtime, CLI, and Cloudflare API seams. Do not test internal
  helpers or generated source strings directly.
- Code is effectively comment-free; add comments only for non-obvious rationale.
- Touch only the requested surface.
- Add catalog dependencies in `pnpm-workspace.yaml`; use `"catalog:"` in packages.
