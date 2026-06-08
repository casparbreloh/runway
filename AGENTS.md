# Runway

A code-first SDK over Cloudflare Workflows for launching coding-agent jobs (e.g. a Linear
issue → a GitHub draft PR). Workflows is the durable engine; Runway adds typed webhook triggers,
a front-Worker router, and four step primitives. A flow is a plain-TS `workflow({ name, trigger, run })`.

## Layout

pnpm workspace, two halves:

- `packages/runway/src/` — the `runway` SDK (`import { workflow, webhook, hmac } from "runway"`).
  - `workflow.ts` — `workflow`/`webhook`/`hmac`, `toEntrypoint` (→ CF `WorkflowEntrypoint`),
    `createRouter` (front Worker: path→trigger, verify, `env[UPPER_SNAKE(name)].create`).
  - `step.ts` — the four primitives (`sandbox`, `shell`, `agent`, `http`) + types + `makeRunwayStep`.
  - `env.ts` — ambient `Env` baseline; `index.ts` — public exports.
- Repo root = the deploy app: `worker.ts` (entry), `workflows/` (one file per flow;
  `linear-to-pr.ts` is the example), `env.d.ts` (app bindings + secrets on `Env`),
  `wrangler.jsonc` (worker/workflow/container/DO config).
- `pnpm-workspace.yaml` — workspace globs + the pinned dependency `catalog:`.

## Commands

- Verify a change: `pnpm typecheck && pnpm lint && pnpm format-check` — the full gate; no test runner.
  - individually: `pnpm typecheck` (tsgo) · `pnpm lint` (oxlint) · `pnpm format` writes / `format-check` checks (oxfmt)
- Run dev: `pnpm dev` (`wrangler dev`; needs Docker for the Sandbox container). Deploy: `pnpm deploy`.
  Regenerate CF binding types: `pnpm cf-typegen`.

## Conventions

- No tests by design — the gate above is it. Typechecking `workflows/linear-to-pr.ts` proves the
  SDK's shape; keep it compiling. Code is comment-free — match it.
- Deps are pinned in the `catalog:` of `pnpm-workspace.yaml` and referenced as `"catalog:"`;
  `catalogMode: strict` rejects inline versions, so add to the catalog first.
- Workflow code runs on workerd, not Node — worker-safe libraries only (`@linear/sdk` ok; avoid
  `node:crypto` paths).
- The four primitives are the only sandbox/network escapes; everything else is plain code in a raw
  `step.do`. Pass secrets via a step's `env` (per-command), never on the command line. Steps can
  re-run on eviction — keep them idempotent.
- Extend the global `Env` in `env.d.ts` (app) or `packages/runway/src/env.ts` (SDK); they merge.
