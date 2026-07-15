# Runway

TypeScript-first general workflow infrastructure for custom triggers, scheduled work, webhooks, and
repository automation on Cloudflare. Author workflows with
`workflow({ id, secrets?, trigger }).handler(async (ctx, event) => { ... })` and export them from
`.runway/workflows/**/*.ts`.

Repository execution and managed CI/CD come first. Cloudflare Sandbox stays internally behind the
runner. Runway will transport caches for tools such as Turborepo and Nx rather than build its
own dependency graph. A future `step.ai()` may use Cloudflare AI Gateway. Agents are deferred.

## Layout

- `packages/runway/` — SDK and `runway` CLI.
  - `src/types.ts` — public contracts.
  - `src/secrets.ts` — secret references.
  - `src/workflow.ts` — `workflow()`.
  - `src/trigger.ts` — webhook and cron triggers.
  - `src/ctx.ts` — `makeCtx()` and `secretsOf()`.
  - `src/runner.ts` — internal managed command runner.
  - `src/runtime.ts` — workflow artifact runtime adapter.
  - `src/host-runtime.ts` — repo Worker host, artifact loading, routing, and runner capability.
  - `src/workflow-artifact.ts` — immutable content-addressed artifact contract.
  - `src/secret-snapshot.ts` — encrypted durable run-secret snapshots.
  - `src/router.ts` — webhook and cron routing.
  - `src/deploy.ts` — validation and deployment orchestration.
  - `src/codegen.ts` — thin generated host configuration and workflow entry modules.
  - `src/validate.ts` — registry validation.
  - `tests/worker.test.ts` — Workers-runtime integration tests using Cloudflare's Vitest pool.
- `example/` — minimal scheduled workflow using `ctx.step.do()` and `ctx.step.exec()`.

## Commands

- Full gate: `pnpm typecheck && pnpm lint && pnpm format-check && pnpm fallow && pnpm test`
- CLI: `runway deploy` and `runway secrets set`.

## Authoring Model

```ts
export default workflow({
  id: "daily-summary",
  trigger: () => cron("0 9 * * *"),
}).handler(async (ctx, event) => {
  await ctx.step.do("record", () => ({ runId: ctx.runId, event }));
  await ctx.step.exec("test", "pnpm test");
  await ctx.step.sleep("wait", 1000);
});
```

- Trigger is required and lives in the `workflow()` object.
- Handler receives `(ctx, event)`. There is no `ctx.params`.
- `ctx` is `{ runId, secrets, env, step: { do, exec, sleep } }`.
- Wrap HTTP and API calls in named `step.do()` calls.
- Use `step.exec(id, command)` for managed shell commands; options can set `cwd`, `env`, and
  `timeoutMs`.
- Step return values must be JSON-serializable and step bodies idempotent.
- Every sleep has a caller-provided stable id.
- Caller-provided step ids must not begin with the reserved `runway:` prefix.

## Triggers And Secrets

- `webhook({ schema })` validates with Standard Schema and types the event as its output.
- `webhook<T>(opts)` is assertion-only typing; `webhook(opts)` gives `unknown`.
- `.filter(typeGuard)` narrows the event and returns a new trigger.
- `cron(expression)` types the event as `{ cron, scheduledTime }`.
- Declare every workflow secret, including webhook signing secrets.
- Trigger secrets are branded name references; handler secrets are runtime strings.
- Deploy fails before upload when a declared secret is missing from env and the repo Worker.

## Runtime And Deployment

- Runway maps `ctx.step.do(id, fn)` to Cloudflare `step.do(id, fn)` and
  `ctx.step.exec(id, command)` to a durable, run-scoped managed command step, and
  `ctx.step.sleep(id, ms)` to `step.sleep(id, ms)`.
- Command steps use deterministic process identities. Workflow retries reconnect to an existing
  running or completed process while the same Sandbox survives instead of starting it again.
- Output is streamed incrementally and only redacted 64 KiB stdout/stderr tails are returned.
- Timeout and termination kill the command process group. Because Cloudflare rollback was `null`
  for a terminated active step in the live deployment smoke test, termination polling remains
  internal to the runner adapter.
- The CLI discovers `.runway/workflows/**/*.ts`, excluding tests, specs, and type files.
- Default exports, named exports, and barrel re-exports are supported.
- Deploy stores each bundled workflow as one immutable content-addressed artifact in the shared
  account R2 bucket before uploading the host. Trigger starts persist only the artifact version;
  resumed Dynamic Workflows load that exact artifact.
- Declared secrets are captured once per run in an encrypted durable snapshot, so secret rotation
  does not alter an active run.
- Runway owns one repo-scoped orchestration Worker, one Worker Loader binding, one matching Dynamic
  Workflow resource, and one `RUNWAY_ARTIFACTS` binding to the shared account artifact bucket.
- Command steps lazily use one internal Cloudflare Sandbox workspace per workflow run and clean it
  up when the run ends. Deploy captures the public repository remote and exact commit inside each
  workflow artifact. The runner prepares `/workspace` before the first command and reconstructs the
  same commit when a fresh Sandbox is missing its matching checkout marker.
- Repository recovery is deterministic reconstruction, not Sandbox workspace checkpointing. The
  Workers-runtime seam covers forced replacement; keep the live `Sandbox.destroy()` smoke and
  checkout measurements pending until they pass against Cloudflare. Sandbox backup/restore still
  needs R2 credentials/configuration and object lifecycle management, so Runway does not enable a
  partial checkpoint layer.
- Deploy updates schedules, removes stale workflow resources for that script, enables workers.dev,
  waits for 31 consecutive cache-busted deployment identity observations over 30 seconds, and then
  returns webhook URLs.
- Keep Sandbox and container deployment resources internal to the managed command runner.

## Conventions

- Keep `example/` typechecking.
- Test behavior at the SDK, Workers runtime, CLI, and Cloudflare API seams. Do not test internal
  helpers or generated source strings directly.
- Code is effectively comment-free; add comments only for non-obvious rationale.
- Touch only the requested surface.
- Add catalog dependencies in `pnpm-workspace.yaml`; use `"catalog:"` in packages.
