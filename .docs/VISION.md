# Runway Vision

Runway is a general, TypeScript-first workflow framework on Cloudflare. It provides typed workflow
definitions, triggers, secrets, routing, discovery, validation, deployment, durable steps, durable
sleep, and managed repository execution without imposing a CI-specific DSL.

Repository execution and managed CI/CD come first. Cloudflare Workflows owns replay, persistence,
and durable waiting. Cloudflare Sandbox stays internally behind `step.exec()` and is not part of the
public workflow context. Runway transports source, caches, logs, and artifacts; tools such as
Turborepo and Nx continue to own dependency graphs, scheduling, and cache keys.

Agents remain deferred until repository execution, caching, and deployments are reliable. A future
`step.ai()` may provide durable model calls through Cloudflare AI Gateway, but AI is not part of the
current foundation.

## Current Foundation

```ts
workflow({ id, secrets?, trigger }).handler(async (ctx, event) => {
  const value = await ctx.step.do("work", async (step) => ({ id: step.id }));
  await ctx.step.exec("test", "pnpm test");
  await ctx.step.sleep("wait", 1000);
});
```

The public context is `{ runId, secrets, env, step: { do, exec, sleep } }`. Every durable operation
has a stable caller-provided id. `step.exec()` has simple defaults and optional `cwd`, `env`, and
`timeoutMs`; Sandbox and container configuration remain internal.

Each repository owns one orchestration Worker, one matching Dynamic Workflow resource, one Worker
Loader binding, and one hidden Sandbox container application. Per-workflow modules are loaded
dynamically, so Cloudflare dashboards are not filled with one static Workflow resource per authored
workflow. There is no account-level execution Worker.

Deployments persist each workflow as one immutable, content-addressed artifact containing its
identity, declared secret names, and bundled source. Dynamic Workflow metadata pins each run to an
artifact version. The typed host runtime verifies the artifact hash before loading it, and durable
encrypted secret snapshots preserve the run's original declared secrets across redeploys and secret
rotation. `runway deploy` waits for 31 consecutive cache-busted deployment identity observations
over 30 seconds before reporting success.

The managed runner currently provides:

- One lazy, isolated Sandbox workspace per workflow run.
- Deterministic process ids and reconnection when a command step retries on the same container.
- Bounded stdout and stderr tails with declared-secret redaction.
- Typed non-zero failures, process-tree timeout cleanup, and active termination monitoring.
- Best-effort workspace reuse across commands and durable sleep while the Sandbox placement
  survives.

## Live Recovery Evidence

On 2026-07-14, an isolated `runway-phase1-smoke` deployment tested the current runner on Cloudflare:

- A marker written to `/workspace` survived a three-minute durable sleep and an inactive container
  cycle. Scale-to-zero alone did not replace that Sandbox placement.
- Calling the runner's supported `Sandbox.destroy()` boundary between commands created a fresh
  container. The next command ran successfully, but the marker was gone. Filesystem continuity is
  therefore not a recovery contract.
- After the same forced replacement, a filtered shallow clone of the public Runway repository
  reconstructed exact commit `da322101847b4da536a52646b98862ee1e1b0b45` in 1,334 ms. The complete
  write, destroy, clone, and verification workflow finished in six seconds.
- One workflow triggered immediately after a successful redeploy executed the previous workflow
  body. A later trigger used the new body. This established the deploy-readiness problem addressed
  by the immutable artifact and readiness work below.

The temporary Worker, Dynamic Workflow, and container application were deleted after the test.

On 2026-07-15, an isolated immutable-artifact deployment held a v1 run in durable sleep, deployed
v2, rotated its secret, and then resumed v1. Fresh runs used only the v2 body and observed the new
secret after propagation; the suspended run resumed with only its pinned v1 body and original
secret. Managed command output remained redacted. Both deployments returned only after the
readiness barrier succeeded.

The smoke test removed and verified absence of its Worker, Dynamic Workflow, Sandbox container
application, and owned R2 artifact objects. It preserved the pre-existing shared artifact bucket.
Cloudflare exposes no supported Worker Loader eviction control, so forced cold-loader recovery was
not exercised live. Workers-runtime tests cover exact metadata-selected artifact and secret loading
at that seam.

Cloudflare Sandbox backup/restore was inspected at the exact SDK version used here, `0.12.3`, but
was not deployed. Production backup requires an R2 binding, bucket name, account id, and S3 access
key credentials. A restored mount is lost again after a container restart and must be restored
again. Successful backup objects are not automatically deleted, so Runway would also own explicit
R2 lifecycle cleanup.

## Recovery Decision

The first repository runner will reconstruct source from the exact commit and restore tool-owned
remote caches. It will not use Sandbox backup/restore for source checkout.

This keeps the recovery model deterministic and avoids adding R2 credentials, backup metadata,
FUSE restore lifecycle, and object cleanup before benchmarks justify them. R2 remains appropriate
for remote caches, logs, and artifacts. Sandbox backup can be reconsidered later for expensive
generated workspace state only if measured restore cost is materially better than reconstruction.

## Delivery Phases

### Phase 1: Repository Bootstrap And Recovery

This is the next implementation phase.

- Introduce an internal repository source descriptor containing the remote, exact commit SHA, and
  an internal authentication capability. Do not add a public checkout DSL.
- Prepare `/workspace` automatically before the first repository command.
- Detect a fresh Sandbox placement or missing prepared workspace before later commands and
  reconstruct the same commit exactly once for that placement.
- Keep command ergonomics unchanged: ordinary workflows continue to call `step.exec()`.
- Support public repositories first, then private repositories through short-lived GitHub App
  credentials without exposing credentials to command output.
- Add seam tests and a repeatable live smoke test that forces `Sandbox.destroy()` between commands.
- Measure cold container start, checkout time, transferred bytes, and recovery overhead.

Phase 1 is complete when a workflow can check out an exact commit, lose its Sandbox, transparently
reconstruct that commit, and continue with the next `step.exec()` without a public recovery call.

### Phase 2: GitHub Repository Runs

- Add typed push and pull-request triggers while keeping `workflow()` as the only workflow DSL.
- Verify GitHub App deliveries and map every run to an exact repository and SHA.
- Report queued, running, success, failure, and cancellation through GitHub Checks.
- Cancel superseded runs for the same pull request or branch.
- Keep one orchestration Worker per repository. If GitHub's app-level webhook requires a shared
  ingress, that component is only a small authenticated router; execution remains repo-scoped.
- Start Dynamic Workflows directly after verified ingress. Add Queues only when measured burst
  handling or rate limits require buffering.

Phase 2 is complete when a push or pull request automatically runs a repository workflow at the
correct SHA and reports its terminal state to GitHub.

### Phase 3: Cache Transport

- Provide R2-backed remote cache transport through the existing Turborepo and Nx protocols.
- Let those tools compute dependency graphs, inputs, and cache keys.
- Namespace objects by account and repository, with integrity validation and bounded retention.
- Configure the required runner environment automatically.
- Measure hit rate, transferred bytes, latency, and storage cost.

Do not add `step.cache(inputs)`, a Runway dependency graph, or a Runway build scheduler. Phase 3 is
complete when an unchanged repository run obtains real remote cache hits after Sandbox replacement.

### Phase 4: Logs, Artifacts, And Run Inspection

- Persist structured command logs outside transient Worker logs.
- Add R2-backed artifact upload and download with explicit retention and size limits.
- Link GitHub Checks to workflow runs, logs, and artifacts.
- Add minimal CLI commands to list and inspect runs.
- Keep cleanup and lifecycle policies automatic and repository-scoped.

Phase 4 is complete when a failed run can be diagnosed and its declared outputs retrieved without
opening the Cloudflare dashboard.

### Phase 5: Deployment Workflows

- Build typed Cloudflare deployment operations usable from ordinary workflows.
- Support pull-request previews, production promotion, and rollback.
- Surface deployment URLs and metadata through workflow results and GitHub Checks.
- Keep deployment capabilities general enough for scheduled and webhook workflows, not only CI.

Phase 5 is complete when a repository workflow can build, publish, report, promote, and roll back a
Cloudflare deployment without introducing a separate CI language.

### Later: AI And Agents

- Add `step.ai()` through Cloudflare AI Gateway only after the CI/CD execution path is reliable.
- Make model calls durable, typed, observable, and cost-accounted.
- Build agent loops from workflow primitives rather than introducing a separate agent runtime.

## Guardrails

- Preserve the small public context and simple `step.exec()` defaults.
- Keep Sandbox, containers, repository credentials, and recovery mechanics internal.
- Prefer reconstruction and standard tool protocols over Runway-specific abstractions.
- Add a shared service only when a provider boundary requires it; keep execution repo-scoped.
- Do not add Queues, new R2-backed subsystems, Durable Objects, or compatibility APIs without a
  measured need.
- Test behavior at SDK, Workers runtime, CLI, Cloudflare API, and live deployment seams.
