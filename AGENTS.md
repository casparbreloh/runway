# Runway

A code-first TypeScript library for durable workflows, split into a **portable core** and a
**pluggable backend**. You author a workflow as plain TS —
`export default createWorkflow({ id, secrets? }).trigger(...).handler(async (ctx) => { ... })`, one per file — list
those files by path in the config, and a backend codegens + deploys the durable runtime. The core (`@runway/core`) is Web-Standards
only with zero Cloudflare deps and owns the durable-execution _contract_; `@runway/cloudflare` is the
one backend today (native Cloudflare Workflows owns replay, persistence, and durable sleep). The
`Backend` seam keeps authoring code portable, so other backends (Vercel, self-hosted Postgres) can
land later without touching a workflow.

## Layout

pnpm workspace, three packages:

- `packages/core/` — `@runway/core`, the portable SDK (`import { createWorkflow, defineConfig } from
"@runway/core"`) plus the CLI (the `runway` bin lives here: `bin/runway.ts`). Web-Standards
  only, no CF deps.
  - `src/types.ts` — the type home: `Ctx` (`runId`/`params`/`secrets`/`env`/`step`/`sleep`), `StepContext`,
    `WorkflowDefinition`/`TriggerBuilder`/`WorkflowBuilder`, the `Primitives` per-backend contract
    (`step<T>(id, fn)` + `sleep(id, ms)`), `RegisteredWorkflow { path, def }` + the `Registry` type
    (`ReadonlyArray<RegisteredWorkflow>`), `WorkflowTrigger` (`WebhookTrigger | CronTrigger`), the
    `Backend` interface (just `deploy`, returning `DeployResult { script, urls }`) + deploy option
    types, and `RunwayConfig` (`{ backend, workflows: ReadonlyArray<string> }`).
  - `src/workflow.ts` — `createWorkflow({ id, secrets? })` (the builder chain; tags the def with
    `__kind: "workflow"`, validates secret names, and rejects a webhook trigger whose `secret` is
    not declared in `secrets`) and `defineConfig`.
  - `src/trigger.ts` — trigger authoring helpers:
    `webhook({ path, secret, header, prefix?, timestamp? }, handle?)` and `cron(expression)`.
    HMAC-SHA256 is the only webhook auth, so its options live flat on the webhook. `secret` names
    one of the workflow's declared secrets (typed: a typo or undeclared name is a type error).
    `handle(body)` is raw TS run at the router after auth: return `undefined`/`null` to skip the
    event, return anything else to make it the run's typed `ctx.params` (inferred from the return
    type — no generics).
  - `src/ctx.ts` — `makeCtx(primitives, { runId, secrets, env })` assembles `ctx` from a backend's
    two primitives; it auto-names each `sleep` positionally so the user passes only ms. Also
    `secretsOf` (pick a workflow's declared secret names from a backend's bindings record, throwing
    `missing secret: NAME` on a miss) — `secrets` and `env` are required on `makeCtx` so a backend
    can't forget to wire them.
  - `src/index.ts` — public barrel.
  - `bin/runway.ts` — the citty CLI: load `runway.config.ts`, map over `config.workflows` (the path
    array) importing each path and taking its `.default`, validate each is a `__kind === "workflow"`
    (else throw `"<path>: expected \"export default createWorkflow(...)\""`) into `{ path, def }`
    pairs (that array IS the `Registry`), then dispatch it to `backend.deploy` and print the
    returned script name + webhook URLs.
- `packages/cloudflare/` — `@runway/cloudflare`, the one backend, in two halves:
  - `src/worker.ts` — the **runtime half** (`@runway/cloudflare/worker`, runs on workerd):
    `toEntrypoint` (→ a CF `WorkflowEntrypoint` class) implements `Primitives` over CF's
    `WorkflowStep` — `step → step.do`, `sleep(ms) → step.sleep` — picks the workflow's declared
    secrets off the Worker env (core's `secretsOf`) and defers to core's `makeCtx`; re-exports
    `createRouter` from `router.ts`. The generated Worker imports this.
  - `src/router.ts` — trigger routing and local-testable runtime code with no `cloudflare:workers`
    import: POST webhook paths verify HMAC auth before JSON parsing, then run the trigger's
    `handle` (nullish return → 200 `{ skipped: true }`, anything else becomes the run params); cron
    events dispatch by cron expression; both call `env[binding].create({ params })`.
  - `tests/worker.ts` — internal no-account test helper; `createTestWorker([workflow], { secrets })`
    signs webhook requests, dispatches cron events, runs handlers with in-memory `step`/`sleep`, and
    records started runs/executions.
  - `src/deploy.ts` — the **deploy half** (`cloudflare(): Backend`, runs on Node): validates
    required secret env vars (the workflow-declared `secrets`, which include webhook secrets),
    codegens the Worker + `.runway/wrangler.jsonc`, esbuild-bundles it, and uploads via the typed
    `cloudflare` SDK. Deploy OWNS the `runway-<project>` script (project = sanitized package name):
    after upload it deletes CF Workflows that belong to the script but are no longer in the
    registry, enables the script on workers.dev (`workers.scripts.subdomain.create`), resolves the
    account subdomain, and returns `DeployResult { script, urls }` with one URL per webhook
    trigger.
    `cloudflare({ sandbox: true })` additionally provisions a Cloudflare Sandbox (no Docker, no
    wrangler): the script upload gains a `Sandbox` DO binding, a one-time sqlite migration (skipped
    when the namespace already exists) and `containers: [{ class_name: "Sandbox" }]` metadata,
    then a container application is upserted via the raw
    `/accounts/{id}/containers/applications` REST endpoints (the typed SDK doesn't cover them)
    pointing at the prebuilt `docker.io/cloudflare/sandbox:<version>` image — the image tag MUST
    match the `@cloudflare/sandbox` npm version (both pinned: `SANDBOX_VERSION` in codegen.ts and
    the exact catalog entry).
  - `src/codegen.ts` — emits the Worker entry (one default import per workflow path —
    `import __w0 from "../src/hello.ts";` — then one `WorkflowEntrypoint` class per workflow bound by
    that default import, class name derived from the id —
    `export class Hello extends toEntrypoint(__w0) {}` — + the trigger router; in sandbox mode also
    `export { Sandbox } from "@cloudflare/sandbox";`), `.runway/wrangler.jsonc` (`nodejs_compat`
    always; sandbox mode adds `containers`/`durable_objects`/`migrations`), and the shared
    `COMPATIBILITY_DATE` + `SANDBOX_VERSION`/`SANDBOX_IMAGE`/`SANDBOX_CLASS`.
  - `src/naming.ts` — `bindingOf`/`classOf`, the binding/class naming for generated code; runtime-safe
    (no Node imports) so the test worker can share it.
  - `src/index.ts` — barrel (`cloudflare`); `./worker` is a separate export for the runtime half.
- `example/` — one dogfood app: `src/issue-review.ts` (the sandbox dogfood: a Linear issue-created
  webhook whose trigger `handle` filters to created issues and returns the SDK-typed issue payload
  as `ctx.params`, runs the pi coding agent in a Cloudflare Sandbox against the issue text, and
  posts the review back with `@linear/sdk`'s `createComment`; the `@cloudflare/sandbox` value
  import is dynamic inside the step because the Node CLI imports every workflow file to read its
  def, and that package only loads on workerd), `runway.config.ts`
  (`defineConfig({ backend: cloudflare({ sandbox: true }), workflows: ["src/issue-review.ts"] })`).
- `pnpm-workspace.yaml` — workspace globs + the pinned dependency `catalog:`.

## Commands

- Verify a change: `pnpm typecheck && pnpm lint && pnpm format-check && pnpm test` — the full gate.
  - individually: `pnpm typecheck` (`tsgo --build`, including `example/`) ·
    `pnpm lint` (oxlint) · `pnpm format` writes / `format-check` checks (oxfmt) · `pnpm test`
    (package-owned Vitest tests; Cloudflare runtime tests use `@cloudflare/vitest-pool-workers`)
- The `runway` CLI (shipped by `@runway/core`) only exposes `runway deploy`. Deploy internally
  codegens/bundles before upload, then prints the script name and one POST URL per webhook trigger.
  A live deploy needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` plus env vars for all
  workflow-declared `secrets` (webhook signing secrets included).

## Conventions

- Keep `example/` typechecking; package tests prove the CLI/deploy/codegen path. Code is
  comment-free — match it.
- Authoring API: `createWorkflow({ id, secrets? }).trigger(webhook(...) | cron(...)).handler(async
(ctx) => ...)`. The chain is `.trigger()` then `.handler()` — a trigger is required and there is
  no default public start endpoint. A webhook's optional second argument `handle(body)` is raw TS
  run at the router after HMAC auth: return `undefined`/`null` to skip the event (200
  `{ skipped: true }`, no run started — one webhook URL can receive an event firehose without
  burning runs), or return a value to make it the run's `ctx.params` — typed by inference from the
  return, no generics anywhere. Without `handle`, `ctx.params` is the raw parsed body (`unknown`).
  The payload's shape is trustworthy because the body is HMAC-verified, so there is no runtime
  schema validation. `cron(...)` types `ctx.params` as `{ cron, scheduledTime }`. The handler is
  fire-and-forget (returns nothing). `ctx` is just `{ runId, params, secrets, env, step, sleep }`:
  `runId` (the run instance id), `params` (see above), `secrets` (the declared secrets, see below), `env` (the
  backend's raw environment, typed `unknown` — the escape hatch to backend-specific bindings like
  the sandbox DO namespace; cast it in the workflow), `step(id, fn)` (a memoized
  durable step; `fn` gets `{ id }`; the id is the idempotency key), and `sleep(ms)` (durable sleep;
  just a number of ms — no id, no duration string). `step` is NAMED — CF needs a stable name and
  named is replay-safe; `sleep` is auto-named positionally by core. The only durable primitives are
  `ctx.step` and `ctx.sleep`; anything else (an HTTP call) is plain TS wrapped inside a `ctx.step`.
- Workflow secrets are declared, typed, and deploy-gated: `secrets: ["LINEAR_API_KEY"]` on
  `createWorkflow` names every secret the workflow needs — including the webhook signing secret,
  which the trigger references by name (`webhook({ secret: "LINEAR_WEBHOOK_SECRET", ... })`, typed
  against the declared union; an undeclared name is a type error AND a `createWorkflow` runtime
  error). The names infer as a literal union so `ctx.secrets.LINEAR_API_KEY` is `string` and any
  undeclared key is a type error (no `secrets` declared → `ctx.secrets` is `{}`, and a webhook
  trigger is then impossible to type). Deploy fails before upload when a declared secret is missing
  from the deploy env; values upload as `secret_text` bindings, and the CF runtime picks the
  declared names off the Worker env. Non-secret config doesn't belong in `secrets` — it's plain TS
  in the workflow file.
- Core owns the durable-execution contract: `makeCtx(primitives, { runId, secrets, env })` builds the
  whole `ctx` in `@runway/core`, auto-naming each `sleep` positionally. A backend implements only the
  thin `Primitives` contract (`step<T>(id, fn)` + `sleep(id, ms)`), resolves declared secrets with
  core's `secretsOf(def.secrets, bindings)`, and inherits `ctx` for free — the CF backend's
  `worker.ts` is a few lines binding `step → step.do` and `sleep(ms) → step.sleep`. New backends
  (Vercel/Postgres) implement `Primitives` and get the rest.
- Registration is an explicit array of workflow file paths in the config — no glob, no per-file scan,
  no registration call. A workflow is one file that default-exports it:
  `export default createWorkflow({ id: "hello", ... }).trigger(...).handler(...)`, one workflow per
  file (no named `export const`, no barrel/re-export). The config names the backend + lists those files by path:
  `runway.config.ts` = `defineConfig({ backend: cloudflare(), workflows: ["src/hello.ts"] })` — an
  array of path STRINGS, so the config holds paths (not imported workflow values) and still imports
  the Node backend without coupling it into the Worker. The CLI imports each listed path, takes its
  `.default`, and validates it's a `__kind === "workflow"` (a clear build-time error if a listed file
  forgot `export default createWorkflow(...)`) into `{ path, def }` pairs (the `Registry`); the CF
  backend then codegens a Worker that emits one default import per path plus one named
  `WorkflowEntrypoint` class per workflow bound by that import —
  `import __w0 from "../src/hello.ts";` … `export class Hello extends toEntrypoint(__w0) {}` (each
  `__wN` its own binding tied to a path; no `import * as`, no array indexing, no `__kind` filter at
  codegen, no `!`). The router gets each trigger by reference (`trigger: __w0.trigger`), never a
  JSON-serialized copy, so function-valued trigger options (`handle`) survive codegen. The `id` stays
  the deploy-time identity (CF `workflow_name` and binding); the webhook trigger path is the public
  route; the class name is derived from the id.
- Deploy = the typed `cloudflare` SDK + esbuild, no subprocess: `deploy` esbuild-bundles to one ESM
  module (`cloudflare:*`, `node:*`, and bare Node builtins external — workerd resolves them under
  `nodejs_compat` v2, which is always on (the Linear SDK needs bare `crypto` + `process.env` at
  runtime); everything else bundled), then `cf.workers.scripts.update` (with
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
