# Runway CI performance: next experiments

Date: 2026-07-18

## Decision

Runway should first remove the losing automatic mise cache path, bake the stable mise bootstrap into
the Sandbox image, and measure clean tool installation. It should not add adaptive caching,
persistent disks, or a second cache system until a simpler baseline loses under live measurement.

Current evidence is decisive enough to set the first experiment:

- clean `standard-4` development samples produced Check P50/P95 of 39s/46s and Test P50/P95 of
  87s/102s;
- a clean mise setup previously took about 7s;
- the automatic mise cache transported about 125 MB compressed for a roughly 482 MB logical tree;
- warm cache restoration varied from about 40s to 2m, with recent Check/Test runs above 2m.

This does not prove caching mise tools is always wrong. It proves this cache representation and
transport are wrong for this workload.

## Provider constraints

The useful pattern from Depot and Blacksmith is not persistent runners:

- both keep job execution ephemeral;
- immutable, common tools arrive through runner images or copy-on-write roots;
- remote caches are placed close to compute and use parallel, streaming transfers;
- durable local state is specialized for Docker layers, repository mirrors, or another narrow
  workload rather than the whole job filesystem;
- Blacksmith deliberately turns degraded cache retrieval into a miss instead of delaying the job;
- both expose step timing, cache behavior, and machine-resource measurements.

Sources:

- [Depot runner architecture](https://depot.dev/docs/github-actions/overview)
- [Depot runner types](https://depot.dev/docs/github-actions/runner-types)
- [Depot metrics](https://depot.dev/docs/github-actions/observability/github-actions-metrics)
- [Blacksmith cache implementation](https://www.blacksmith.sh/blog/cache)
- [Blacksmith dependency cache](https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions)
- [Blacksmith metrics](https://docs.blacksmith.sh/blacksmith-observability/metrics)

## Ranked experiments

### 1. Image-baked mise bootstrap, clean tool install

Bake the mise binary and its fixed OS dependencies into the digest-pinned Sandbox image. Keep tool
versions repository-owned and install them from `.mise.toml` or inline provider configuration on
each fresh run. Remove the mise provider's automatic filesystem cache declaration.

This preserves the public `tools: mise()` interface. It changes only the provider implementation
and runner image. The image digest remains the rollout and reproducibility boundary.

Success condition: Check and Test both beat the automatic-cache live baseline, and the provider
setup phase stays below 15s at P95. If it also returns near the earlier clean-run distribution, stop
and ship this simple design.

### 2. Phase-level cache and setup measurements

Measure the operations already owned by the Sandbox and provider boundary:

- Sandbox allocation and readiness;
- checkout;
- cache lookup and time to first byte;
- download bytes, duration, and effective throughput;
- verification and staging/restoration;
- provider bootstrap and tool installation;
- authored command duration;
- cache capture, compression, upload, and publication.

Record compressed and logical bytes. Distinguish cache miss, exact hit, restore-key hit, bypass,
timeout, integrity failure, and publication loss. Keep measurements internal; do not expand the
author API.

Success condition: one run timeline explains at least 95% of delivery-to-terminal wall time without
double-counting overlapping work.

### 3. Bounded, fail-open remote restore

Only if a remaining filesystem cache has a plausible win, give restore a provider-owned deadline.
When lookup, transfer, or restore becomes slower than the conservative clean-work estimate, abort
the cache work, discard staged state, and continue as a miss. Integrity failures also remain misses
unless they indicate an internal invariant violation.

Start with a fixed deadline supported by measurements. Do not build a predictor or public tuning
surface in the first version.

Success condition: an injected slow or stalled cache cannot extend a run beyond the fixed restore
budget, and correctness matches an ordinary miss.

### 4. Parallel streaming transport

Only if experiment 3 shows that useful cache objects are transfer-bound, test bounded parallel R2
range reads or multipart objects, connection reuse, streaming digest verification, and safe overlap
between download and restoration. Bound concurrency and memory; measure end-to-end restoration,
not raw R2 throughput.

Success condition: representative restore P95 beats clean recomputation by at least 20%, including
verification and materialization. Otherwise remove the optimization.

### 5. Narrow placement-local or attached state

If transfer remains the bottleneck, prototype one named cache family on storage colocated with the
Sandbox or an adjacent service. Candidate workloads are mise downloads, Git objects, or BuildKit
state—not `/workspace` and not a general prior-run filesystem. Preserve repository/trust scope,
successful-run-only publication, and deterministic reconstruction.

Success condition: a repeated workload wins on latency and estimated total cost without weakening
ephemeral isolation or source continuity.

### 6. Cloudflare Sandbox backup as an alternate cache representation

Prototype the Sandbox SDK backup/restore path for one immutable cache tree. In production it restores
a SquashFS archive through a FUSE copy-on-write overlay, which may avoid Runway's current full-tree
staging copy. Keep the current integrity, ownership, publication, and reconstruction rules around the
experiment; an SDK backup handle is transport evidence, not sufficient integrity evidence by itself.

This is a credible Cloudflare-native experiment, not an immediate replacement. It adds another cache
representation, R2 lifecycle ownership, and restart behavior. Remove it unless the complete restore
path wins decisively.

Source: [Cloudflare Sandbox backup and restore](https://developers.cloudflare.com/sandbox/guides/backup-restore/)

### 7. Edge-cache immutable R2 objects

Test a private Worker gateway and custom-domain Cloudflare Cache for content-addressed cache objects.
Digest-addressed objects are immutable, so relaxed CDN consistency is acceptable for object bytes;
mutable cache references must continue to use strongly consistent R2 access. Measure whether the
Sandbox repeatedly lands close enough to a warm edge copy for this to matter.

Do not expose the bucket publicly or put authorization into the cache key. A miss must fall back to
authenticated R2 and cache corruption must remain detectable from the object digest.

Sources:

- [How R2 works](https://developers.cloudflare.com/r2/how-r2-works/)
- [R2 consistency and caching](https://developers.cloudflare.com/r2/reference/consistency/)

### 8. Specialized follow-ups

Evaluate checkout mirrors, pre-hydrated container images, and tool-native CAS only after the common
runner path is fast. Each should be its own adapter and benchmark because its key, trust boundary,
publication rule, and reuse pattern differ from generic filesystem cache.

## Minimal two-loop design

### Small local workflow runner

A local flow is worthwhile if it remains an adapter, not a local reimplementation of Runway. Add one
command such as `runway run <workflow> --event <file>` that reuses workflow discovery and executes the
same `WorkflowDefinition` with a local `Step` implementation:

- `step.do` calls the body directly;
- `step.exec` uses the exact pinned Linux image with the same command, environment, and timeout
  contract;
- `step.cache` is bypassed until a benchmark justifies a local cache implementation;
- `step.sleep` uses the real clock;
- tool providers wrap these same operations, so mise and mixed-provider behavior is exercised.

This seam already mostly exists in `WorkflowDefinition`, `makeStep`, and `withTools`. One small Docker
adapter is worthwhile because it catches Linux/image/provider mismatches while isolating the host
checkout. Keep the command deliberately incomplete: no trigger server, Cloudflare durability
emulation, matrix scheduler, UI, watch mode, second workflow format, or local cache service. A first
useful version should be a few focused files and hundreds, not thousands, of lines.

Cloudflare Workflows and Durable Objects have local emulation, but Workflows and Containers cannot be
connected as remote bindings. Therefore a local run can prove workflow behavior and compare local
algorithms; it cannot support claims about production allocation, placement, R2 transfer, restart, or
total latency.

Sources:

- [Cloudflare Workflows local development](https://developers.cloudflare.com/workflows/build/local-development/)
- [Cloudflare bindings by development mode](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)
- [Cloudflare Container lifecycle and placement](https://developers.cloudflare.com/containers/platform-details/architecture/)

### Loop A: local correctness and mechanics

Purpose: reject broken or mechanically expensive candidates before deploying.

Use one checked-in fixture contract with generated content matching the observed shapes: many small
files, executable files, symlinks/hardlinks, and a bounded large payload. Do not check the payload
into Git. Run each candidate through the public/deep Sandbox interface, not private helpers.

For every candidate:

1. run miss, save, exact restore, restore-key restore, timeout/bypass, and integrity-failure paths;
2. verify restored behavior and file semantics;
3. record CPU time, wall time, peak memory, compressed/logical bytes, and bytes read/written;
4. repeat five times after one untimed warm-up;
5. discard candidates that lose to clean setup locally or add a new public concept.

Local results validate implementation mechanics; they do not support a production speed claim.

### Loop B: live Cloudflare decision

Purpose: measure the real placement, R2, Sandbox, checkout, and GitHub-trigger path.

Use one exact commit and the existing Check and Test workflows. Change one variable per deployment.
Run candidates sequentially to avoid resource contention:

1. deploy and verify the exact image/host identity;
2. run one untimed smoke for correctness;
3. collect five sequential development samples for a quick reject;
4. collect 15 sequential samples only for a candidate that wins the quick comparison;
5. report P50/P95 for delivery-to-start, allocation/readiness, checkout, provider setup, each cache
   phase, authored commands, and delivery-to-terminal;
6. report failure/bypass counts, compressed/logical bytes, effective throughput, and estimated
   variable cost per run.

Compare, in order:

1. current automatic full-tree mise cache;
2. image-baked mise with clean tool installation;
3. image-baked mise plus any bounded cache candidate that survived Loop A.

A candidate wins only when both Check and Test improve at P50 and do not regress materially at P95.
Prefer the candidate with fewer runtime states and less code when results overlap.

## Initial implementation sequence

The first two small branches should contain only:

- mise and fixed bootstrap dependencies in the pinned Sandbox image;
- removal of the mise provider's automatic full-tree cache;
- internal phase measurements needed for the two loops;
- one isolated local workflow runner that reuses the pinned image and existing Step/provider seams;
- behavioral tests for provider setup, metric classification, and cache fail-open behavior touched by
  the change;
- benchmark evidence recorded in the PR.

Do not add a public cache policy, provider registry, persistent volume abstraction, or compatibility
layer. Those are separate decisions that require evidence from these experiments.
