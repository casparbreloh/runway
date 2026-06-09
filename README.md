# Runway

A code-first TypeScript library for durable workflows. The core (`@runway/core`) is a portable,
Web-Standards-only authoring SDK with zero Cloudflare deps that owns the durable-execution contract;
the durable runtime is a **pluggable backend**. Today there is one — `@runway/cloudflare`, backed by
native Cloudflare Workflows, which owns replay, persistence, and durable sleep. The `Backend` seam
keeps your workflows portable, so other backends (Vercel, self-hosted Postgres) can be added later
without touching authoring code.

You author with `@runway/core` but run the `runway` CLI, which `@runway/core` ships as its `bin`.

## A workflow

```ts
// src/hello.ts
import { createWorkflow } from "@runway/core";

export default createWorkflow({ id: "hello" }).handler(async (ctx) => {
  const greeting = await ctx.step("greet", () => "hello");
  await ctx.sleep(5000);
  await ctx.step("finish", () => `${greeting} world (run ${ctx.runId})`);
});
```

`createWorkflow({ id }).handler(fn)` defines a workflow. Each workflow is the default export of its
own file; you list those files by path in the config (see Wiring). Handlers are fire-and-forget — they
return nothing. The only durable primitives are `ctx.step` (a memoized durable step, named by its
idempotency key) and `ctx.sleep` (durable sleep, just a number of ms). Anything else — an HTTP call,
for example — is plain TypeScript wrapped inside a `ctx.step`.

## `ctx`

The single handler argument is just `{ runId, step, sleep }`:

- `ctx.runId` — the run instance id.
- `ctx.step(id, fn)` — a durable, memoized step; `id` is the idempotency key and `fn` receives
  `{ id }`. Returns a JSON-serializable value. Steps re-run on replay, so keep them idempotent.
- `ctx.sleep(ms)` — durable sleep. `ms` is a plain number of milliseconds; there is no id and no
  duration string.

## Wiring

Each workflow lives in its own file as the default export. Point `runway.config.ts` at a backend and
list those files by path:

```ts
// runway.config.ts
import { cloudflare } from "@runway/cloudflare";
import { defineConfig } from "@runway/core";

export default defineConfig({ backend: cloudflare(), workflows: ["src/hello.ts"] });
```

`workflows` is an explicit array of path strings — it holds paths, not imported workflow values, so
the config can import the Node backend without coupling it into the Worker. The CLI imports each
listed path, takes its `.default`, and validates it's tagged `__kind: "workflow"` (a clear build-time
error if a listed file forgot `export default createWorkflow(...)`), producing `{ path, def }` pairs.
The backend codegens a Worker that emits one default import per path plus one Cloudflare
`WorkflowEntrypoint` per workflow, bound by that import —
`import __w0 from "../src/hello.ts";` … `export class Hello extends toEntrypoint(__w0) {}`. The `id`
stays the deploy-time identity (the `workflow_name`, the binding, the `/runs/:id` route); the class
name is derived from it. No glob, no autodiscovery magic — just an explicit path list.

## CLI

- `runway build` — import each listed workflow path to collect the workflows, codegen the Worker (one
  `WorkflowEntrypoint` per workflow + a generic `POST /runs/:id` router) and esbuild-bundle it. No
  upload — the offline shape proof.
- `runway deploy` — build, then upload via the typed `cloudflare` SDK (`cf.workers.scripts.update`
  with a `type: "workflow"` binding + `cf.workflows.update` per workflow). No wrangler, no Docker.

Deploying needs Cloudflare credentials in the environment:

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
runway deploy
```

Once deployed, start a run by POSTing to the Worker (the body is passed through as the run params):

```sh
curl -X POST https://<your-worker>/runs/hello -d '{}'
```
