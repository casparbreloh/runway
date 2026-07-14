# Runway Vision

Runway is a general, TypeScript-first workflow framework on Cloudflare. It provides typed workflow
definitions, triggers, secrets, routing, discovery, validation, deployment, durable steps, and
durable sleep without imposing a CI-specific DSL.

## Product Direction

Repository execution and managed CI/CD come first. Workflows can run tools through durable
`step.exec()` operations while Cloudflare Workflows owns replay, persistence, and durable waiting.
Cloudflare Sandbox stays internally behind that runner; it is not part of the public workflow
context.

Runway will transport caches for existing tools such as Turborepo and Nx. It will not build its own
dependency graph or replace those tools' scheduling and cache semantics.

Agents are deferred until the repository runner proves the execution model. A future `step.ai()`
may provide model calls through Cloudflare AI Gateway, but AI is not part of the current foundation.

## Current Model

```ts
workflow({ id, secrets?, trigger }).handler(async (ctx, event) => {
  const value = await ctx.step.do("work", async (step) => ({ id: step.id }));
  await ctx.step.exec("test", "pnpm test");
  await ctx.step.sleep("wait", 1000);
});
```

The public context contains `runId`, declared runtime `secrets`, raw `env`, and a `step` object with
`do(id, fn)`, `exec(id, command)`, and `sleep(id, durationMs)`. Explicit ids make durable operations
visible and stable. Command execution uses one lazily created, isolated workspace per workflow run.
There are no compatibility aliases for the former callable step or top-level sleep APIs.

## Deployment Topology

Each repository owns one orchestration Worker, one matching Dynamic Workflow resource, and one
Worker Loader binding. The Worker routes webhooks and schedules, while dynamically loaded workflow
modules execute through Cloudflare Workflows. Runway reconciles only resources owned by that
repo-scoped deployment.

The topology also includes a hidden Sandbox durable object, a matching container application, and
an internal runner bridge. It has no public Sandbox API, R2, Queues, or account-level execution
Worker.

## Near-Term Non-Goals

- A CI-specific workflow language.
- A dependency graph or build scheduler.
- Public container or Sandbox primitives.
- Agents or an agent runtime.
- AI Gateway integration.
- Repository checkout, caching, GitHub integration, R2, Queues, artifacts, or deployments before
  their respective phases are designed and implemented.

The foundation should stay small enough that repository execution remains a deep internal module
rather than spreading across the authoring API.
