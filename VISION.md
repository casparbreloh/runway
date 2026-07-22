# Runway Vision

Runway is a general workflow and repository-runner foundation on Cloudflare. TypeScript is the
authoring language; repository commands and cached filesystem trees are language-neutral. The goal
is a smaller CI primitive that can become faster and more cost-sensitive than hosted runners through
exact execution semantics, generic persistent state, direct transfer, and measured infrastructure
rather than ecosystem-specific magic.

Repository execution and managed CI/CD come first. Cloudflare Sandbox stays internal. Runway
transports exact Source and generic Cache state; tools such as Turborepo, Nx, sccache, and Bazel keep
their own dependency graphs, hashes, and protocols. Package-manager and language-runtime helpers may
be built later as separate consumers.

Agents remain deferred until repository execution, caching, measurement, and Stack ownership are
reliable. A future model primitive may use Cloudflare AI Gateway, but AI is not part of this
foundation.

## Author Model

```ts
workflow({ id, secrets?, trigger? }).run(async (run) => {
  await run.cache("compiler-state", {
    key: { files: ["compiler.lock"] },
    path: "/cache/compiler-state",
  });
  await run.do("metadata", () => ({ ready: true }));
  await run.exec("check", "./scripts/check");
  await run.sleep("settle", 1000);
});
```

The public Run contains only `runId`, declared secrets, and flat `do`, `exec`, `cache`, and `sleep`
methods. Sandbox placement, Source credentials, cache refs and transfer capabilities, terminal
claims, Meter samples, provider steps, and Stack receipts remain internal.

The public cache declaration names caller-owned trees and one caller-defined string or exact-source
file key. Private normalized cache trees enforce byte/time budgets. Cache is not a package-manager
DSL, dependency graph, content-store API, or checkpoint primitive.

## Foundation Boundaries

### Run And Sandbox

Run is the author capability. Sandbox is the deep run-bound module that owns one exact Source,
mutable placement, processes, cache lifecycle, and cleanup. `do` and `sleep` allocate no Sandbox.
Source/cache/command work starts it lazily.

Each command has canonical intent and a deterministic process identity. A durable retry reconnects
only when the same placement, process, and command digest are proven. If a placement is lost after a
command started or may have started, the run fails instead of replaying a potentially mutating
command. Cache restoration never authorizes replay.

### Source

Source is a credential-free repository URL plus stable repository identity and exact immutable Git
revision. Checkout mints credentials only for its own process, verifies `HEAD`, and removes its
credential helper before authored commands. The returned evidence contains no credential or remote
with embedded authentication.

Before any command may have started, a replacement Sandbox can reconstruct the same exact Source.
After that boundary, continuity must be proven rather than inferred from files.

Cloudflare Artifacts is a possible later Source implementation. It will be adopted only if a stable
service contract and repeated exact-revision P50/P95 plus total-cost measurements beat ordinary
checkout for declared workloads. It is not the Cache store, and its availability is not part of the
current foundation contract.

### Terminal

Terminal is the one durable owner of the run winner and external terminal effect. Success, failure,
cancellation, and supersession all claim through the same authority. Same-outcome retries return the
winner; conflicting claims cannot change it. Only the verified winning success can publish eligible
caches and report external success.

### Cache

Cache owns one generic filesystem tree. Runtime-derived repository, trigger, branch/PR/fork,
platform, image, schema, runner ABI, and generation state determine trust and compatibility; authors
cannot spell an access scope.

The private implementation uses immutable content-addressed SquashFS objects and conditional named
refs in private R2. Large bodies transfer directly Sandbox-to-R2 through short-lived exact-object
capabilities; they do not pass through workflow author code. Restore verifies content, schema,
platform, tree safety, and budgets in a sibling staging directory before atomic rename. Absence,
corruption, unavailability, policy, target, or budget failures become diagnosed misses/skips without
mutating a non-empty target.

Cache schema 2 and runner ABI `runway-sandbox-v2` add a bounded canonical private hardlink trailer to
the SquashFS bytes. The pinned image contains high-level `squashfuse`, which does not expose reliable
inode identity; the trailer preserves regular-file hardlinks without parsing compressed SquashFS
metadata or weakening validation. It is a private compatibility boundary and can change only with a
schema/ABI miss.

Publication is success-only. Candidate bodies may be staged and verified while the run is active,
but failure, cancellation, supersession, unsafe capture, budget rejection, or stale conditional refs
cannot advance shared state.

### Meter

Meter records bounded sandbox/source/exec/reconnect/cache/loss/run lifecycle, timing, byte, and
outcome samples. It does not record usage quantities or estimate provider costs.

### Stack

Stack is the only owner of desired Cloudflare resources for one repository deployment. Its manifest
and immutable receipts cover Worker version/deployment, Dynamic Workflow, container definition and
rollout, Durable Object namespaces, workers.dev, routes, schedules, bindings, secret names, private
buckets, lifecycle, and exact owned objects. Apply and remove re-inventory provider state, fail closed
on replacement drift, and preserve unknown or shared state.

The developer app and Worker/Workflow resource name are exactly **Runway** / `runway`, not Runway CI
or `runway-ci`. The deployed Stack uses a digest-pinned linux/amd64 Sandbox image,
runner ABI `runway-sandbox-v2`, cache schema 2, and internal `standard-4` capacity. Capacity is not a
public author option.

### Connection And Releases

`runway connect github` is the one-time developer action that establishes the repository Stack and
configures Cloudflare Workers Builds for the default branch. Runway has no normal `deploy` or
`publish` command. Pushes to a connected repository produce releases automatically from the exact
commit selected by the build.

The repository Worker is a stable structural host. Workflow bodies, artifact hashes, GitHub filters,
and webhook paths do not appear in its generated source or force a Worker deployment. A release
bundles workflows independently, hashes them, uploads only missing immutable artifacts, writes one
immutable repository registry, and atomically advances an active pointer only after every referenced
artifact is verified. Admission validates the active registry and persists the exact artifact version
for the run, so later activation cannot alter an active or resumed workflow.

Connection, structural Stack reconciliation, and release activation are separate internal
operations. The current all-in-one internal publication path is transitional and should be deleted,
not exposed as product UX. Ordinary workflow changes perform artifact upload and registry activation
only. Stack reconciliation remains necessary for actual structural changes such as the Runway host,
container image, bindings, secret names, provider routes, or Cloudflare schedules; it must not upload
or wait for an unchanged Worker deployment. The Stack remains lifecycle owner of the repository
registry namespace and its exact release objects even though release activation does not change the
structural Stack generation.

Explicit execution remains local: `runway run <workflow>` invokes the current checkout with the
reduced local semantics described below. There is no planned `runway run --cloud`. Cloud runs begin
from connected automatic triggers and an exact published commit; a second manual cloud admission
path is not justified.

## Development Evidence And Boundary

Nothing here is production. The repository exercises the system as if it were production while
comparative release claims and publication remain gated.

At PR head `df10a82` on 2026-07-17, 15 sequential development samples on the deployed `runway`
integration produced Check P50/P95 of 39s/46s, Test P50/P95 of 87s/102s, and delivery-to-terminal
P50/P95 of 96s/105s, with no cache operations. This supports the primitive decision; it is not a
comparative release claim.

The live Stack is exactly `runway` on the digest-pinned linux/amd64 `standard-4` container. The legacy
Worker, Workflow, container, namespaces, public bootstrap bucket, and migration receipt are deleted.
The private shared workflow-artifact bucket and unclaimed objects survived the cutover.

Private R2 miss, publication, warm restore, and corrupt-input behavior passed live. Runway's own
whole-tree Node/pnpm caches were then removed because they regressed both latency and estimated cost.
Future ecosystem adapters must prove a net win rather than adding package-manager semantics to the
foundation.

The repository's duplicate GitHub Actions workflow was removed only after an earlier evidence gate.
A `.github/workflows` fallback must not be restored without a new explicit migration and live gate.

## Next Steps

Work proceeds as sequential vertical slices. Each slice starts from merged `main`; do not build later
slices against an unmerged predecessor.

1. **Land and prove local run:** merge the trigger-independent `runway run <workflow>` path, then
   exercise Runway's unchanged Check and Test workflows from a clean checkout. An optional normalized
   JSON event fixture supplies callbacks that need one. Local execution uses host commands, rejects
   declared secrets, skips cache transport, and does not emulate durable Cloudflare semantics.
2. **Connect GitHub with dynamic releases:** implement `runway connect github` as one vertical slice
   from merged `main`. Configure Workers Builds, establish the stable structural host, upload only
   missing content-addressed workflow artifacts, atomically activate an immutable repository
   registry, and prove that an ordinary workflow edit neither deploys nor waits for the Worker.
3. **Make the GitHub App conditional:** only when `github()` is declared, use the GitHub App Manifest
   flow, direct webhooks to the repository Worker, retain credentials only in the user's Cloudflare
   account, and mint short-lived repository- and permission-scoped installation tokens. Delete the
   current manual App credential setup rather than preserving compatibility.
4. **Delete transitional publication:** replace the current monolithic internal publication path with
   connection, structural reconciliation, and release activation boundaries. Re-inventory exact
   ownership, preserve unknown/shared resources, deduplicate immutable uploads, and update provider
   schedules without redeploying an unchanged host.
5. **Evidence and release gates:** prove exact local and connected-GitHub paths live, then build
   same-source runtime cohorts and comparative benchmarks before making release claims.

## Open Issues

### Cloudflare TypeScript Worker multipart serialization

With `cloudflare@7.0.0`, the declared `workers.scripts.update({ metadata, files })` call serializes
multipart fields as `metadata[main_module]` and `files[]`. The Workers API expects one JSON
`metadata` part and module parts addressed by filename. The generated request fails live Worker
validation even though the SDK input matches its types.

Related reports [cloudflare-typescript#158](https://github.com/cloudflare/cloudflare-typescript/issues/158)
and [cloudflare-typescript#2645](https://github.com/cloudflare/cloudflare-typescript/issues/2645)
are closed; no open report matched this v7 regression on 2026-07-20. Runway's Cloudflare adapter
therefore sends the stable filename-addressed REST multipart contract directly and tests its exact
shape. Remove that adapter path only after the SDK request succeeds against the live endpoint.

## Publication Gates

The foundation primitives are independent of comparative marketing evidence. Before publication:

1. Handle every positively owned live run, disable legacy admission, remove only receipt-owned legacy
   resources, and independently verify their absence.
2. Create the fresh exact `runway` Stack on `standard-4`, verify its receipt equals provider inventory,
   and preserve unknown/shared resources and the shared artifact bucket.
3. Prove private cache miss, success-only publication, warm restore, corruption fallback,
   cancellation fencing, credential unobservability, and cleanup in the exact pinned image.
4. Remove the obsolete public bootstrap only after the new cache is no longer dependent on it.
5. Run a statistically meaningful comparison against identical GitHub four-core commands before
   publishing relative speed or cost claims; report webhook-to-terminal P50/P95 and provider-backed
   total variable infrastructure cost.
6. Pass local and live behavior gates plus standards, specification, and architecture review before
   publication.

Any image, capacity, limit, or Stack generation change after measurement invalidates the evidence.
Public-repository GitHub standard compute is free, so Runway competes there on feedback time and
capability rather than a lower compute bill.

## Later Consumers

After the foundation gates pass:

- Add thin tool-native Turbo, Nx, sccache, Bazel, or similar transports only for real users while
  preserving tool-owned graphs, hashes, and validation.
- Add separately packaged repository helpers for package managers or language runtimes; do not add
  those concepts to Run, Sandbox, Source, Terminal, Cache, Meter, or Stack.
- Persist structured logs and explicit run artifacts with repository-scoped lifecycle and budgets.
- Build deployment workflows from ordinary Run primitives.
- Evaluate repository acceleration, BuildKit, pulled-image caches, and agent/session workloads as
  distinct cache families with their own measurement and trust contracts.
- Add AI and agents only after repository execution, caching, and deployments are proven reliable.

## Guardrails

- Keep `workflow(...).run(...)` and flat `run.do/exec/cache/sleep` small.
- Keep Cloudflare Sandbox, provider steps, credentials, cache storage, and Stack ownership internal.
- Prefer exact reconstruction and proven continuity over filesystem inference.
- Preserve one Terminal winner and success-only publication.
- Keep the foundation language-neutral; ecosystem setup belongs in consumers.
- Separate target/model numbers from measured evidence and label cost provenance.
- Preserve shared artifacts and unknown provider state; remove only positively owned resources.
- Do not add compatibility layers, speculative adapters, AI, agents, or public capacity controls
  before a real consumer proves the seam.
