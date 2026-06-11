# Runway

Code-first TypeScript library for durable workflows. Author workflows with
`workflow({ id, secrets?, trigger }).handler(async (ctx, event) => { ... })`, export them from
`.runway/workflows/**/*.ts`, and let a backend codegen + deploy the runtime.

Core is portable and Web-Standards only. `@runway/cloudflare` is the only backend today: Cloudflare
Workflows own replay, persistence, and durable sleep. The `Backend` interface keeps authoring code
portable for future Vercel/Postgres/self-hosted backends.

## Layout

- `packages/core/` — `@runway/core`, SDK + `runway` CLI.
  - `src/types.ts` — public contracts: `Ctx`, triggers, registry, backend/deploy types.
  - `src/secrets.ts` — `SecretRef`, `secretRef`, `secretNameOf`.
  - `src/workflow.ts` — `workflow()` + `defineConfig`.
  - `src/trigger.ts` — `webhook()`, `.filter()`, `cron()`, trigger validation.
  - `src/ctx.ts` — `makeCtx()` and `secretsOf()`.
  - `bin/runway.ts` — loads config, discovers workflow exports, calls `backend.deploy`.
- `packages/cloudflare/` — Cloudflare backend.
  - `src/worker.ts` — workerd runtime adapter: `toEntrypoint(def)`, `step.do`, `step.sleep`.
  - `src/router.ts` — local-testable webhook/cron routing, HMAC, schema/filter gating.
  - `src/deploy.ts` — Node deploy path: validate env, codegen, esbuild, Cloudflare SDK upload.
  - `src/codegen.ts` — generated Worker module imports/classes/router.
  - `src/validate.ts` — registry validation.
  - `tests/worker.ts` — no-account integration helper.
- `example/` — dogfood Linear issue review workflow using OpenRouter + Linear inside `ctx.step`.

## Commands

- Full gate: `pnpm typecheck && pnpm lint && pnpm format-check && pnpm test`
- Individual checks:
  - `pnpm typecheck` — `tsgo --build`, includes `example/`
  - `pnpm lint` — `oxlint`
  - `pnpm format` / `pnpm format-check` — `oxfmt`
  - `pnpm test` — Vitest
- CLI: only `runway deploy`.
- Live deploy needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and all declared workflow
  secrets.

## Authoring Model

```ts
export default workflow({
  id: "issue-review",
  secrets: ["LINEAR_WEBHOOK_SECRET", "LINEAR_API_KEY"],
  trigger: (ctx) =>
    webhook<LinearWebhookPayload>({
      path: "/linear",
      secret: ctx.secrets.LINEAR_WEBHOOK_SECRET,
      signatureHeader: "linear-signature",
    }).filter(
      (event): event is EntityWebhookPayloadWithIssueData =>
        "type" in event && event.type === "Issue" && event.action === "create",
    ),
}).handler(async (ctx, event) => {
  await ctx.step("work", async () => {
    void ctx.secrets.LINEAR_API_KEY;
    void event.data;
  });
});
```

- Trigger is required and lives in the `workflow()` object, not a chained `.trigger()`.
- Handler receives `(ctx, event)`. There is no `ctx.params`.
- `ctx` is `{ runId, secrets, env, step, sleep }`.
- Only `ctx.step(id, fn)` and `ctx.sleep(ms)` are durable primitives.
- Wrap HTTP/API calls in named steps. Keep step return values JSON-serializable.
- Steps can replay. Keep them idempotent.

## Triggers

- `webhook({ schema })` validates with Standard Schema and types `event` as validate output.
  Failing validation skips the run: `200 { skipped: true }`.
- `webhook<T>(opts)` is assertion-only typing after HMAC verification.
- `webhook(opts)` gives `event: unknown`.
- `.filter(typeGuard)` is predicate-only, narrows the event type, AND-composes, and returns a new
  trigger.
- `cron(expression)` types `event` as `{ cron, scheduledTime }`.
- Webhooks are POST-only and HMAC-SHA256 only.
- Shared webhook paths are allowed only when verification config is identical.
- Router behavior: 404 no route, 401 auth/timestamp failure, 400 signed malformed JSON, 500
  throwing predicate/rejecting schema, 202 when at least one run starts.

## Secrets

- Declare every workflow secret in `secrets`, including webhook signing secrets.
- In `trigger(ctx)`, `ctx.secrets.X` is a branded `SecretRef<"X">` name carrier.
- In the handler, `ctx.secrets.X` is the runtime `string` value.
- `webhook({ secret })` takes a `SecretRef`, never a raw string.
- Deploy fails before upload when any declared secret env var is missing.
- Non-secret config belongs in normal TypeScript, not `secrets`.

## Backend Contract

- Core owns `makeCtx(primitives, { runId, secrets, env })`.
- A backend only implements `Primitives`: `step<T>(id, fn)` and `sleep(id, ms)`.
- Cloudflare maps those to `step.do(id, fn)` and `step.sleep(id, ms)`.
- `sleep(ms)` is auto-named positionally by core (`sleep-0`, `sleep-1`, ...).
- Core must stay Cloudflare-free. Worker-specific code lives in `@runway/cloudflare`.

## Registration And Deploy

- CLI discovers `.runway/workflows/**/*.ts` by default, excluding tests/specs/types.
- Default exports, named exports, and barrel re-exports are supported.
- Only exports tagged `__kind === "workflow"` are registered.
- Registry entries are `{ path, exportName, def }`.
- Codegen imports workflow modules by reference so schemas and filter functions survive bundling.
- Deploy owns the `runway-<package-name>` script, updates workflow bindings/cron schedules, removes
  stale workflows for that script, enables workers.dev, and returns webhook URLs.

## Conventions

- Keep `example/` typechecking.
- Code is effectively comment-free; match that unless a comment explains a non-obvious why.
- Touch only the requested surface.
- Add catalog deps in `pnpm-workspace.yaml`; use `"catalog:"` in packages.
- Do not reintroduce sandbox primitives in this PR. If needed, use provider SDKs manually inside a
  normal step in separate work.
