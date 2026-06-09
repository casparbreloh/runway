# Runway

A code-first TypeScript library for durable workflows, split into a **portable core** and a
**pluggable backend**. You author a workflow as plain TS —
`export default createWorkflow({ id }).handler(async (ctx) => { ... })`, one per file — list those
files by path in the config, and a backend codegens + deploys the durable runtime. The core (`@runway/core`) is Web-Standards
only with zero Cloudflare deps and owns the durable-execution _contract_; `@runway/cloudflare` is the
one backend today (native Cloudflare Workflows owns replay, persistence, and durable sleep). The
`Backend` seam keeps authoring code portable, so other backends (Vercel, self-hosted Postgres) can
land later without touching a workflow.

## Layout

pnpm workspace, three packages:

- `packages/core/` — `@runway/core`, the portable SDK (`import { createWorkflow, defineConfig } from
"@runway/core"`) plus the CLI (the `runway` bin lives here: `bin/runway.ts` + `cli/`). Web-Standards
  only, no CF deps.
  - `src/types.ts` — the type home: `Ctx` (`runId`/`step`/`sleep`), `StepContext`,
    `WorkflowDefinition`/`WorkflowBuilder`, the `Primitives` per-backend contract (`step<T>(id, fn)` +
    `sleep(id, ms)`), `RegisteredWorkflow { path, def }` + the `Registry` type
    (`ReadonlyArray<RegisteredWorkflow>`), the `Backend` interface + build/deploy option types, and
    `RunwayConfig` (`{ backend, workflows: ReadonlyArray<string> }`).
  - `src/workflow.ts` — `createWorkflow` (the builder; tags the def with `__kind: "workflow"`) and
    `defineConfig`.
  - `src/ctx.ts` — `makeCtx(primitives, { runId })` assembles `ctx` from a backend's two primitives;
    it auto-names each `sleep` positionally so the user passes only ms.
  - `src/index.ts` — public barrel.
  - `cli/run.ts` — `build`/`deploy`: load `runway.config.ts`, map over `config.workflows` (the path
    array) importing each path and taking its `.default`, validate each is a `__kind === "workflow"`
    (else throw `"<path>: expected \"export default createWorkflow(...)\""`) into `{ path, def }`
    pairs (that array IS the `Registry`), then dispatch it to `backend.build`/`deploy`.
    `bin/runway.ts` — the citty CLI.
- `packages/cloudflare/` — `@runway/cloudflare`, the one backend, in two halves:
  - `src/worker.ts` — the **runtime half** (`@runway/cloudflare/worker`, runs on workerd):
    `toEntrypoint` (→ a CF `WorkflowEntrypoint` class) implements `Primitives` over CF's
    `WorkflowStep` — `step → step.do`, `sleep(ms) → step.sleep` — then defers to core's `makeCtx`;
    `createRouter` is the generic `POST /runs/:id` → `env[binding].create({ params })` starter. The
    generated Worker imports this.
  - `src/deploy.ts` — the **deploy half** (`cloudflare(): Backend`, runs on Node): `build` codegens
    the Worker + esbuild-bundles it; `deploy` additionally uploads via the typed `cloudflare` SDK.
  - `src/codegen.ts` — emits the Worker entry (one default import per workflow path —
    `import __w0 from "../src/hello.ts";` — then one `WorkflowEntrypoint` class per workflow bound by
    that default import, class name derived from the id —
    `export class Hello extends toEntrypoint(__w0) {}` — + the router) plus the `bindingOf`/`classOf`
    id helpers.
  - `src/index.ts` — barrel (`cloudflare`); `./worker` is a separate export for the runtime half.
- `example/` — one dogfood app: `src/hello.ts` (default-exports a workflow:
  `export default createWorkflow({ id: "hello" }).handler(...)`), `runway.config.ts`
  (`defineConfig({ backend: cloudflare(), workflows: ["src/hello.ts"] })`).
- `pnpm-workspace.yaml` — workspace globs + the pinned dependency `catalog:`.

## Commands

- Verify a change: `pnpm typecheck && pnpm lint && pnpm format-check` — the full gate; no test runner.
  - individually: `pnpm typecheck` (tsgo + `@runway/cloudflare` `tsgo --noEmit`) · `pnpm lint` (oxlint) ·
    `pnpm format` writes / `format-check` checks (oxfmt)
- The gate does NOT typecheck `example/`. The offline SDK-shape proof is `cd example && runway build`
  — imports each `config.workflows` path to collect the registry, codegens `.runway/worker.gen.ts`,
  and esbuild-bundles it, proving the generated Worker compiles and the codegen→bundle pipeline works
  end-to-end.
- The `runway` CLI (shipped by `@runway/core`): `runway build` (codegen + bundle, no upload) and
  `runway deploy` (build, then upload via the typed `cloudflare` SDK). A live `runway deploy` needs
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in the env. No wrangler, no Docker.

## Conventions

- No tests by design — the gate above is it. Keep `example/` building under `runway build`; it proves
  the SDK's shape (`createWorkflow`, `ctx.step`/`ctx.sleep`, the codegen→bundle path). Code is
  comment-free — match it.
- Authoring API: `createWorkflow({ id }).handler(async (ctx) => ...)`. The handler is fire-and-forget
  (returns nothing). `ctx` is just `{ runId, step, sleep }`: `runId` (the run instance id),
  `step(id, fn)` (a memoized durable step; `fn` gets `{ id }`; the id is the idempotency key), and
  `sleep(ms)` (durable sleep; just a number of ms — no id, no duration string). `step` is NAMED — CF
  needs a stable name and named is replay-safe; `sleep` is auto-named positionally by core. The only
  durable primitives are `ctx.step` and `ctx.sleep`; anything else (an HTTP call) is plain TS wrapped
  inside a `ctx.step`.
- Core owns the durable-execution contract: `makeCtx(primitives, { runId })` builds the whole `ctx`
  in `@runway/core`, auto-naming each `sleep` positionally. A backend implements only the thin
  `Primitives` contract (`step<T>(id, fn)` + `sleep(id, ms)`) and inherits `ctx` for free — the CF
  backend's `worker.ts` is a few lines binding `step → step.do` and `sleep(ms) → step.sleep`. New
  backends (Vercel/Postgres) implement `Primitives` and get the rest.
- Registration is an explicit array of workflow file paths in the config — no glob, no per-file scan,
  no registration call. A workflow is one file that default-exports it:
  `export default createWorkflow({ id: "hello" }).handler(...)`, one workflow per file (no named
  `export const`, no barrel/re-export). The config names the backend + lists those files by path:
  `runway.config.ts` = `defineConfig({ backend: cloudflare(), workflows: ["src/hello.ts"] })` — an
  array of path STRINGS, so the config holds paths (not imported workflow values) and still imports
  the Node backend without coupling it into the Worker. The CLI imports each listed path, takes its
  `.default`, and validates it's a `__kind === "workflow"` (a clear build-time error if a listed file
  forgot `export default createWorkflow(...)`) into `{ path, def }` pairs (the `Registry`); the CF
  backend then codegens a Worker that emits one default import per path plus one named
  `WorkflowEntrypoint` class per workflow bound by that import —
  `import __w0 from "../src/hello.ts";` … `export class Hello extends toEntrypoint(__w0) {}` (each
  `__wN` its own binding tied to a path; no `import * as`, no array indexing, no `__kind` filter at
  codegen, no `!`). The `id` stays the deploy-time identity (CF `workflow_name`, the binding, the
  router route); the class name is derived from the id.
- Deploy = the typed `cloudflare` SDK + esbuild, no subprocess: `deploy` esbuild-bundles to one ESM
  module (`cloudflare:*` external, everything else bundled), then `cf.workers.scripts.update` (with
  typed `type: "workflow"` bindings) + `cf.workflows.update` per workflow. Credentials =
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` env vars (the seam for a future hosted product).
  Runs start via `POST /runs/<id>` to the deployed Worker. No wrangler, no Docker.
- The `Backend` interface (`build`/`deploy`, taking the `Registry`) is the plug point: how `ctx.step`
  becomes durable is private to each backend's `build`. CF is the only backend now; Vercel/Postgres
  can be added without touching authoring code.
- Steps re-run on eviction and replay — keep them idempotent; step return values must be
  JSON-serializable.
- Deps are pinned in the `catalog:` of `pnpm-workspace.yaml` and referenced as `"catalog:"`;
  `catalogMode: strict` rejects inline versions, so add to the catalog first.
- The core `@runway/core` package is CF-free — worker-specifics live only in `@runway/cloudflare`. Its
  `/worker` half runs on workerd (`@cloudflare/workers-types`); its deploy half is Node (`cloudflare`
  SDK + esbuild).
