# Runway

A code-first TypeScript library for durable workflows, split into a **portable core** and a
**pluggable backend**. You author a workflow as plain TS —
`export default createWorkflow({ id, trigger }).handler(async (ctx) => { ... })` — export
workflows from `.runway/workflows/**/*.ts` by default, and a backend codegens + deploys the durable runtime. The core (`@runway/core`) is Web-Standards
only with zero Cloudflare deps and owns the durable-execution _contract_; `@runway/cloudflare` is the
one backend today (native Cloudflare Workflows owns replay, persistence, and durable sleep). The
`Backend` seam keeps authoring code portable, so other backends (Vercel, self-hosted Postgres) can
land later without touching a workflow.

## Layout

pnpm workspace, three packages:

- `packages/core/` — `@runway/core`, the portable SDK (`import { createWorkflow, defineConfig } from
"@runway/core"`) plus the CLI (the `runway` bin lives here: `bin/runway.ts`). Web-Standards
  only, no CF deps.
  - `src/types.ts` — the type home: `Ctx` (`runId`/`params`/`secrets`/`step`/`sleep`), `StepContext`,
    `WorkflowDefinition`/`WorkflowBuilder`, the `Primitives` per-backend contract (`step<T>(id, fn)` +
    `sleep(id, ms)`), `RegisteredWorkflow { path, exportName, def }` + the `Registry` type
    (`ReadonlyArray<RegisteredWorkflow>`), `WorkflowTrigger` (`WebhookTrigger | CronTrigger`), the
    `Backend` interface (just `deploy`) + deploy option types, and `RunwayConfig`
    (`{ backend, include?, exclude? }`).
  - `src/workflow.ts` — `createWorkflow` (the builder; tags the def with `__kind: "workflow"`,
    validates declared secret names) and `defineConfig`.
  - `src/trigger.ts` — trigger authoring helpers: `webhook({ path, auth })`, `cron(expression)`, and
    `hmacSha256({ header, secret, prefix?, timestamp? })`; `secret` is the env/binding name.
  - `src/ctx.ts` — `makeCtx(primitives, { runId, secrets })` assembles `ctx` from a backend's two
    primitives; it auto-names each `sleep` positionally so the user passes only ms. Also `secretsOf`
    (pick a workflow's declared secret names from a backend's bindings record, throwing
    `missing secret: NAME` on a miss) — `secrets` is required on `makeCtx` so a backend can't
    forget to wire it.
  - `src/index.ts` — public barrel.
  - `bin/runway.ts` — the citty CLI: load `runway.config.ts` (fallback `.runway/runway.config.ts`),
    discover files from `include`/`exclude` globs (default `.runway/workflows/**/*.ts`, excluding
    tests/specs/types), import each matched module, collect default and named exports tagged
    `__kind === "workflow"` into `{ path, exportName, def }` pairs, then dispatch that `Registry` to
    `backend.deploy`.
- `packages/cloudflare/` — `@runway/cloudflare`, the one backend, in two halves:
  - `src/worker.ts` — the **runtime half** (`@runway/cloudflare/worker`, runs on workerd):
    `toEntrypoint` (→ a CF `WorkflowEntrypoint` class) implements `Primitives` over CF's
    `WorkflowStep` — `step → step.do`, `sleep(ms) → step.sleep` — picks the workflow's declared
    secrets off the Worker env (core's `secretsOf`) and defers to core's `makeCtx`; re-exports
    `createRouter` from `router.ts`. The generated Worker imports this.
  - `src/router.ts` — trigger routing and local-testable runtime code with no `cloudflare:workers`
    import: POST webhook paths verify HMAC auth before JSON parsing, cron events dispatch by cron
    expression, and both call `env[binding].create({ params })`.
  - `tests/worker.ts` — internal no-account test helper; `createTestWorker([workflow], { secrets })`
    signs webhook requests, dispatches cron events, runs handlers with in-memory `step`/`sleep`, and
    records started runs/executions.
  - `src/deploy.ts` — the **deploy half** (`cloudflare(): Backend`, runs on Node): validates
    required secret env vars (webhook secrets + workflow-declared `secrets`), codegens the Worker
    in memory, esbuild-bundles it, and uploads via the typed `cloudflare` SDK.
  - `src/codegen.ts` — emits the Worker entry (one namespace import per workflow module, then one
    `WorkflowEntrypoint` class per workflow export, class name derived from the id —
    `export class Hello extends toEntrypoint(__m0.default) {}` — + the trigger router), and the
    shared `COMPATIBILITY_DATE`.
  - `src/naming.ts` — `bindingOf`/`classOf`, the binding/class naming for generated code; runtime-safe
    (no Node imports) so the test worker can share it.
  - `src/index.ts` — barrel (`cloudflare`); `./worker` is a separate export for the runtime half.
- `example/` — one dogfood app: `.runway/workflows/hello.ts` (default-exports a workflow with a
  required trigger: `export default createWorkflow({ id: "hello", trigger: webhook(...) }).handler(...)`),
  `runway.config.ts` (`defineConfig({ backend: cloudflare() })`).
- `pnpm-workspace.yaml` — workspace globs + the pinned dependency `catalog:`.

## Commands

- Verify a change: `pnpm typecheck && pnpm lint && pnpm format-check && pnpm test` — the full gate.
  - individually: `pnpm typecheck` (`tsgo --build`, including `example/`) ·
    `pnpm lint` (oxlint) · `pnpm format` writes / `format-check` checks (oxfmt) · `pnpm test`
    (package-owned Vitest tests; Cloudflare runtime tests use `@cloudflare/vitest-pool-workers`)
- The `runway` CLI (shipped by `@runway/core`) only exposes `runway deploy`. Deploy internally
  codegens/bundles before upload. A live deploy needs `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID` plus env vars for any webhook secrets named by triggers and any
  workflow-declared `secrets`.

## Conventions

- Keep `example/` typechecking; package tests prove the CLI/deploy/codegen path. Code is
  comment-free — match it.
- Authoring API: `createWorkflow({ id, trigger, secrets? }).handler(async (ctx) => ...)`. Trigger is
  required; there is no default public start endpoint. The handler is fire-and-forget (returns
  nothing). `ctx` is just `{ runId, params, secrets, step, sleep }`: `runId` (the run instance id),
  `params` (trigger payload), `secrets` (the declared secrets, see below), `step(id, fn)` (a memoized
  durable step; `fn` gets `{ id }`; the id is the idempotency key), and `sleep(ms)` (durable sleep;
  just a number of ms — no id, no duration string). `step` is NAMED — CF needs a stable name and
  named is replay-safe; `sleep` is auto-named positionally by core. The only durable primitives are
  `ctx.step` and `ctx.sleep`; anything else (an HTTP call) is plain TS wrapped inside a `ctx.step`.
- Workflow secrets are declared, typed, and deploy-gated: `secrets: ["LINEAR_API_KEY"]` on
  `createWorkflow` names the secrets the handler needs (each provided as an env var at deploy); the
  names infer as a literal union so `ctx.secrets.LINEAR_API_KEY` is `string` and any undeclared key
  is a type error (no `secrets` declared → `ctx.secrets` is `{}`). Deploy fails before upload when a
  declared secret (or webhook secret) is missing from the deploy env; values upload as `secret_text`
  bindings, and the CF runtime picks the declared names off the Worker env. Non-secret config
  doesn't belong in `secrets` — it's plain TS in the workflow file.
- Core owns the durable-execution contract: `makeCtx(primitives, { runId, secrets })` builds the
  whole `ctx` in `@runway/core`, auto-naming each `sleep` positionally. A backend implements only the
  thin `Primitives` contract (`step<T>(id, fn)` + `sleep(id, ms)`), resolves declared secrets with
  core's `secretsOf(def.secrets, bindings)`, and inherits `ctx` for free — the CF backend's
  `worker.ts` is a few lines binding `step → step.do` and `sleep(ms) → step.sleep`. New backends
  (Vercel/Postgres) implement `Primitives` and get the rest.
- Registration is convention-based. The config names the backend and can optionally customize
  repo-root-relative `include`/`exclude` globs; by default the CLI discovers `.runway/workflows/**/*.ts`
  and excludes tests/specs/types. It imports each matched module, collects every default or named
  export tagged `__kind === "workflow"`, dedupes the same workflow object through barrel re-exports,
  validates duplicate ids, and passes `{ path, exportName, def }` pairs as the `Registry`; the CF
  backend then codegens a Worker that namespace-imports modules and emits one named
  `WorkflowEntrypoint` class per workflow export. The `id` stays the deploy-time identity (CF
  `workflow_name` and binding); the webhook trigger path is the public route; the class name is
  derived from the id.
- Deploy = the typed `cloudflare` SDK + esbuild, no subprocess: `deploy` esbuild-bundles to one ESM
  module (`cloudflare:*` external, everything else bundled), then `cf.workers.scripts.update` (with
  typed `type: "workflow"` bindings plus `secret_text` bindings for webhook secrets and declared
  workflow `secrets`) + `cf.workflows.update` per workflow + Worker cron schedule updates.
  Credentials = `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` env vars; webhook secrets and
  declared workflow `secrets` are required (as env vars) at deploy time. Runs start via POST to the
  configured webhook trigger path.
- The `Backend` interface (`deploy`, taking the `Registry`) is the plug point: how `ctx.step` becomes
  durable is private to each backend. CF is the only backend now; Vercel/Postgres can be added
  without touching authoring code.
- Steps re-run on eviction and replay — keep them idempotent; step return values must be
  JSON-serializable.
- Deps are pinned in the `catalog:` of `pnpm-workspace.yaml` and referenced as `"catalog:"`;
  `catalogMode: strict` rejects inline versions, so add to the catalog first.
- The core `@runway/core` package is CF-free — worker-specifics live only in `@runway/cloudflare`. Its
  `/worker` half runs on workerd (`@cloudflare/workers-types`); its deploy half is Node (`cloudflare`
  SDK + esbuild).
