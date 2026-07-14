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
  - `src/runtime.ts` — generated Worker runtime adapter.
  - `src/router.ts` — webhook and cron routing.
  - `src/deploy.ts` — validation, codegen, bundle, and Cloudflare upload path.
  - `src/codegen.ts` — generated orchestration and workflow Worker modules.
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
- The CLI discovers `.runway/workflows/**/*.ts`, excluding tests, specs, and type files.
- Default exports, named exports, and barrel re-exports are supported.
- Runway owns one repo-scoped orchestration Worker, one Worker Loader binding, and one matching
  Dynamic Workflow resource.
- Command steps lazily use one internal Cloudflare Sandbox workspace per workflow run and clean it
  up when the run ends.
- Deploy updates schedules, removes stale workflow resources for that script, enables workers.dev,
  and returns webhook URLs.
- Keep Sandbox and container deployment resources internal to the managed command runner.

## Conventions

- Keep `example/` typechecking.
- Test behavior at the SDK, Workers runtime, CLI, and Cloudflare API seams. Do not test internal
  helpers or generated source strings directly.
- Code is effectively comment-free; add comments only for non-obvious rationale.
- Touch only the requested surface.
- Add catalog dependencies in `pnpm-workspace.yaml`; use `"catalog:"` in packages.
