# Runway

Runway is a language-neutral workflow and repository-runner foundation on Cloudflare. Its public
surface stays small while exact source, execution continuity, cache safety, terminal ownership,
measurement, and infrastructure ownership remain deep internal responsibilities.

## Language

**Step**:
The author-facing durable capability for one workflow execution. It exposes only `runId`, declared
secrets, and the flat `do`, `exec`, `cache`, and `sleep` primitives.
_Avoid_: Context, runner, public Sandbox

**Tool Provider**:
An ordered, declarative adapter that restores its private cache, prepares tools once before the first
authored command, and contributes command environment. Providers do not execute authored steps and
do not own cache transport.
_Avoid_: Tool registry, setup step, plugin runner

**Sandbox**:
The run-bound owner of one exact Source, its mutable placement, processes, cache lifecycle, and
cleanup. A Sandbox may reconnect to proven continuity, but it never treats cached files as authority
to replay a command that may have started.
_Avoid_: Repository sandbox, managed runner, workspace checkpoint

**Source**:
A credential-free repository location paired with one exact immutable revision. Authentication is
an internal, ephemeral checkout capability and never part of author state or prepared source evidence.
_Avoid_: Checkout config, mutable branch, workspace snapshot

**Terminal**:
The sole durable authority that selects one winning run outcome and owns its external terminal
effect. Conflicting success, failure, cancellation, or supersession attempts cannot replace the winner.
_Avoid_: Final status, completion callback

**Cache**:
One caller-named set of filesystem trees restored before command execution and eligible for publication only
after durable success. It is generic, trust-scoped, budgeted, integrity-checked, and never a Source,
checkpoint, dependency graph, or tool preset.
_Avoid_: Dependency cache, package cache, snapshot manager

**Meter**:
The bounded record of latency, bytes, terminal outcomes, and billable quantities, with explicit
provider, aggregate, derived, or allocated provenance. Estimates are not provider invoices.
_Avoid_: Logger, billing record

**Stack**:
The exact desired Cloudflare resources owned by one repository deployment, together with immutable
ownership evidence. Removal applies only to positively owned resources and preserves unknown or
shared state.
_Avoid_: Deploy helpers, account inventory

## Foundation Invariants

- Authors define `workflow({ id, secrets?, tools?, trigger }).run(...)` and use only
  `step.do/exec/cache/sleep`. Tool providers are ordered consumers of the generic command and cache
  foundation; Sandbox and checkout remain internal.
- Source identity is exact and immutable. Placement loss after a command may have started is terminal
  unless the same placement, process, and command digest are proven.
- Terminal is the one owner of the durable winner; only its winning success can authorize cache
  publication and the external success effect.
- Cache payloads are private content-addressed SquashFS objects. Cache schema 2 and runner ABI
  `runway-sandbox-v2` include a bounded canonical private hardlink trailer so regular-file identity is
  preserved even though the pinned image exposes only high-level `squashfuse`.
- A Stack derives one deployment name from its Git repository. Its Worker, Dynamic Workflow, and
  container share that name; its two Durable Object namespaces append `-github` and `-sandbox`.
  Account state and data live in the shared `runway-state` and `runway-data` buckets.
- Cloudflare Artifacts may become a Source implementation only after repeated exact-revision latency
  and total-cost evidence wins. It is not the Cache store.
- Agents are deferred until the runner, cache, and deployment foundation is proven.
