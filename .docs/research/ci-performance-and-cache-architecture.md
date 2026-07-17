# Runway CI performance and cache architecture research

Research date: 2026-07-16. Foundation evidence updated: 2026-07-17.

## Executive conclusion

The fast-provider pattern is not “keep runners alive.” It is:

> Ephemeral execution plus persistent, named, repository-scoped state placed close to compute.

Depot terminates each runner after its job and keeps cache state externally. Blacksmith starts a
fresh Firecracker VM and attaches or clones persistent cache disks into it. Neither provider
documents reusing an arbitrary prior runner filesystem as its primary cache mechanism.
[Depot runner architecture](https://depot.dev/docs/github-actions/overview),
[Blacksmith cache architecture](https://www.blacksmith.sh/blog/cache)

For Runway, this implies:

1. Keep **Sandbox** as one internal, run-bound foundation term. Authors use the flat `Run` surface;
   Cloudflare Sandbox, placement, processes, and cleanup remain implementation details.
2. Build one internal cache plane with immutable objects, trust-aware namespaces,
   successful-run-only publication, observability, and fail-open misses.
3. Keep specialized cache families separate. Tool installations, dependency stores, task outputs,
   Git objects, workspace snapshots, and BuildKit state have different keys, lifecycles,
   concurrency, and security boundaries.
4. Investigate a digest-pinned OCI runner profile as the language-neutral environment primitive.
   Publish it only if a default/Python/Rust spike proves the compatible Sandbox control server,
   entrypoint, image identity, and safe rollout/versioning strategy.
5. Replace the root repository’s custom public archive/chunk bootstrap only after the new
   primitives are proven by Runway’s own CI.
6. Benchmark before claiming Runway is faster than GitHub. The desired foundation manifest now uses
   `standard-4` at 4 vCPU and 12 GiB, while GitHub gives this public repository 4 vCPU and 16 GiB.
   The still-live legacy `runway-monorepo` stack remains on `standard-1` at 0.5 vCPU and 4 GiB;
   it is not the final benchmark configuration. Caching can beat GitHub on warm paths, but it cannot
   hide weak cold compute. [Cloudflare instance types](https://developers.cloudflare.com/containers/platform-details/limits/),
   [GitHub-hosted runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

### Evidence status on 2026-07-17

The foundation source now has the flat `workflow(...).run(...)` and `run.do/exec/cache/sleep`
surface, exact Source and continuity rules, one Terminal owner, generic safe cache behavior, bounded
Meter quantities, exact Stack ownership, cache schema 2, runner ABI `runway-sandbox-v2`, and a
digest-pinned linux/amd64 `standard-4` desired manifest. This is local implementation evidence.

At exact PR head `90a34ae`, the existing installed integration automatically ran Check
`87800799473` successfully in 2m46s and Test `87800798140` successfully in 3m14s. Those two durations
are **measured legacy-stack exact-head evidence**, not cold/warm cache samples and not a comparison
with GitHub Actions.

No private-cache warm hit, repeatable live miss/corrupt/cancel set, 20-sample benchmark, cost win,
fresh `runway` Stack cutover, or legacy/bootstrap deletion has been proven. The live legacy stack is
still `runway-monorepo`/`standard-1`; the desired fresh stack is `runway`/`standard-4`. The private
shared workflow-artifact bucket and unknown shared objects remain preservation boundaries.

| Evidence or gate                     | Performance                         | Cost                                               | Status                         |
| ------------------------------------ | ----------------------------------- | -------------------------------------------------- | ------------------------------ |
| Legacy exact-head Check/Test         | 2m46s / 3m14s for one PR head       | No complete per-run Meter cost captured            | Measured; not a benchmark      |
| Desired `standard-4` cold comparison | P50 and P95 ≤1.10× GitHub four-core | ≤0.75× paid GitHub four-core list-price equivalent | Target; no samples yet         |
| Desired `standard-4` warm comparison | P50 and P95 ≤0.60× GitHub four-core | ≤0.50× paid GitHub four-core list-price equivalent | Target; no live warm proof yet |

The targets require at least 20 cold and 20 warm samples on the same commit and commands, and total
variable infrastructure quantities rather than container compute alone.

## Verified provider facts

### Depot

Depot launches fresh, single-tenant EC2 instances from a pre-provisioned pool and terminates them
after each job. Its runner filesystem is not reused. Cache entries live in encrypted distributed
storage outside the runner. [Depot runner architecture](https://depot.dev/docs/github-actions/overview)

Its cache families are distinct:

- GitHub Actions cache traffic is transparently redirected to Depot’s distributed cache. Depot
  documents repository scope without automatic branch isolation; users control isolation through
  cache keys. [Depot runner documentation](https://depot.dev/docs/github-actions/overview)
- Depot Cache stores tool-native outputs for Bazel, Go, Turborepo, sccache, Pants, Gradle, Maven,
  moonrepo, and compatible GitHub Actions. These results can be shared between CI and developer
  machines. General entries default to 14-day retention, configurable by age and storage size.
  [Depot Cache](https://depot.dev/docs/cache/overview)
- Docker builds run on remote BuildKit hosts with a persistent project-scoped layer cache. Builds
  within a project share it, while projects are isolated.
  [Depot container builds](https://depot.dev/docs/container-builds/overview)
- Fork PR container builds for open-source repositories receive isolated builders with no access
  to the project cache, preventing disclosure and cache poisoning.
  [Depot container-build isolation](https://depot.dev/docs/container-builds/overview)
- Depot can deduplicate identical BuildKit work across concurrent builds.
  [Depot build parallelism](https://depot.dev/docs/container-builds/build-parallelism)
- Optional custom runner AMIs preinstall organization-specific software. Ultra runners use a RAM
  disk for fast ephemeral workspace I/O. Neither is equivalent to persisting a prior workspace.
  [Depot runner documentation](https://depot.dev/docs/github-actions/overview),
  [Depot Ultra Runners](https://depot.dev/blog/introducing-github-actions-ultra-runners)

Depot’s proactive work is infrastructure-oriented: pre-provisioned runner capacity, prefetched
images, optional prebuilt AMIs, and automatic cache integration. It does not document predicting
future repository outputs.

### Blacksmith

Blacksmith runs each job in an ephemeral Firecracker VM on bare-metal hosts with local NVMe. The
root filesystem comes from GitHub’s runner images; the VM itself is not the persistent cache.
[Blacksmith architecture](https://www.blacksmith.sh/blog/cache),
[Blacksmith runner images](https://docs.blacksmith.sh/blacksmith-runners/overview)

Its cache families include:

- Native GitHub cache requests are transparently routed through an in-VM and host proxy to storage
  in the same data center as the runner. Dependency entries are branch/tag scoped by default, with
  an explicit option to share them repository-wide.
  [Blacksmith cache implementation](https://www.blacksmith.sh/blog/cache),
  [Blacksmith dependency cache](https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions)
- Sticky disks are ext4 snapshots stored in a Ceph cluster backed by local NVMe. Blacksmith clones
  the last committed snapshot, mounts it into the VM, and commits it after the job. Documented
  uses include package-manager stores, `node_modules`, and Bazel caches.
  [Blacksmith sticky disks](https://docs.blacksmith.sh/blacksmith-caching/dependencies-sticky-disks)
- Docker BuildKit state is stored on repository-shared sticky disks. Updates publish only after a
  successful, non-cancelled job. Concurrent writers use last-write-wins, and optional size limits
  prune least-used layers.
  [Blacksmith Docker cache](https://docs.blacksmith.sh/blacksmith-caching/docker-builds)
- Git checkout caching maintains a bare mirror, incrementally fetches Git objects, and lets
  workspaces use Git alternates. Initial hydration or cache failures fall back to a normal clone.
  This remains beta.
  [Blacksmith Git checkout cache](https://docs.blacksmith.sh/blacksmith-caching/git-checkout-caching)
- Pulled container images are retained on an organization-wide sticky disk and arrive pre-extracted
  on later runners.
  [Blacksmith container cache](https://docs.blacksmith.sh/blacksmith-caching/docker-container-caching)

This is the closest analogue for Runway: restore named filesystem state into an otherwise fresh
run-bound Sandbox.

### Performance-claim caveats

Depot’s “10x cache” number compares vendor-measured transfer throughput of roughly 100–150 MB/s on
GitHub with up to 1 GB/s on Depot. It is transfer throughput, not total job latency. Depot’s
end-to-end comparison is one Next.js workflow and combines CPU, memory, disk, network, and cache
differences. [Depot cache implementation](https://depot.dev/blog/github-actions-cache),
[Depot side-by-side benchmark](https://depot.dev/blog/comparing-github-actions-and-depot-runners-for-2x-faster-builds)

Blacksmith’s “4x” documentation compares one 6 GB cache at approximately 90 MB/s versus 400 MB/s.
Its later “up to 10x” post presents one roughly 114 MB customer example. Its Docker “2x–40x” range
is customer-reported. These are useful hot-cache examples, not controlled cross-workload proof.
[Blacksmith sticky disks](https://docs.blacksmith.sh/blacksmith-caching/dependencies-sticky-disks),
[Blacksmith cache implementation](https://www.blacksmith.sh/blog/cache),
[Blacksmith Docker cache](https://docs.blacksmith.sh/blacksmith-caching/docker-builds)

Neither provider establishes that caching alone universally beats GitHub. Cache warmth,
changed-file distribution, CPU, disk, network, and task granularity are confounders.

## Current cost and performance model

The prices in this section were checked on 2026-07-16. They are public list prices, not quotes.
Taxes, negotiated contracts, support commitments, regional capacity, and provider-specific CPU
performance are not normalized.

### Cloudflare Containers and Runway

Containers require the Workers Paid plan, whose account-wide minimum is $5/month. That plan
currently includes 25 GiB-hours of container memory, 375 vCPU-minutes, and 200 GB-hours of
container disk per month. Overage is measured every 10 ms at:

- `$0.0000025` per provisioned GiB-second of memory;
- `$0.000020` per active vCPU-second;
- `$0.00000007` per provisioned GB-second of disk.

Charges start when a container receives a request or is started and stop when it sleeps. CPU is
billed from active use; memory and disk are billed from the provisioned instance size while the
container is active. [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)

Relevant instance types are:

| Type         | vCPU | Memory |  Disk |
| ------------ | ---: | -----: | ----: |
| `standard-1` |  0.5 |  4 GiB |  8 GB |
| `standard-2` |    1 |  6 GiB | 12 GB |
| `standard-3` |    2 |  8 GiB | 16 GB |
| `standard-4` |    4 | 12 GiB | 20 GB |

[Cloudflare instance types](https://developers.cloudflare.com/containers/platform-details/limits/)

At full CPU utilization and after the included allowances, the derived container-only cost per
active wall-clock minute is:

```text
60 × (
  active vCPU × $0.000020
  + provisioned GiB × $0.0000025
  + provisioned GB disk × $0.00000007
)
```

This is approximately `$0.0012336/min` for `standard-1` and `$0.006684/min` for `standard-4`.
These are derived saturation examples, not Cloudflare-quoted SKU prices. A workload using less CPU
costs less, while slow cache restore, dependency download, and idle-active time still incur memory
and disk charges. Assuming no other account usage, the first included allowance becomes exhausted
after about 375 active `standard-1` minutes because of memory, or 93.75 fully utilized
`standard-4` minutes because of CPU.

Container egress includes 1 TB/month in North America and Europe, then costs `$0.025/GB`; the
included allowance is 500 GB in other published regions, followed by `$0.04–$0.05/GB` depending on
region. The documentation does not state whether every intra-Cloudflare container-to-R2 transfer
is exempt from Container egress, so cost models should not assume that it is.
[Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/)

Runway also consumes Workers, Durable Objects, Workflows, logs, and R2:

- The $5 Workers Paid minimum includes 10 million Worker requests and 30 million CPU-ms per month;
  overage is `$0.30/million` requests and `$0.02/million` CPU-ms. Workers themselves have no data
  transfer charge. SQLite Durable Objects include 1 million requests, 400,000 GB-s duration,
  25 billion rows read, 50 million rows written, and 5 GB-month of stored data before their
  respective overages. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- Workers Logs includes 20 million events/month with seven-day retention, then costs
  `$0.60/million` additional events.
  [Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- Workflows uses the normal Worker request and CPU rates. The Paid plan includes 1 GB-month of
  Workflow state and 500,000 steps; starting no earlier than 2026-08-10, overage will be
  `$0.20/GB-month` and `$0.80/100,000` steps. Idle waits do not consume Workflow CPU.
  [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)

These orchestration charges are likely small beside container compute for ordinary CI, but that is
an inference requiring production usage measurements.

### R2 cache storage

R2 Standard storage includes 10 GB-month, 1 million Class A mutations, and 10 million Class B reads
per month. Overage is `$0.015/GB-month`, `$4.50/million` Class A operations, and
`$0.36/million` Class B operations. R2 does not charge egress through the Workers API, S3 API, or
public R2 endpoints. Cloudflare rounds usage up to the next published billing unit.
[R2 pricing](https://developers.cloudflare.com/r2/pricing/)

R2 Infrequent Access is not a good default for hot CI caches: it costs `$0.01/GB-month` but adds
`$0.01/GB` retrieval, has no free tier, and has a 30-day minimum storage duration. Standard storage
has neither retrieval fees nor a minimum duration.
[R2 storage classes](https://developers.cloudflare.com/r2/buckets/storage-classes/)

R2's raw storage price is materially lower than managed cache-disk prices below, but those products
include indexing, transfer acceleration, snapshots, and runner integration. Comparing only
`$/GB-month` is not comparing equivalent services.

### GitHub-hosted runners

For public repositories, standard GitHub-hosted runners are free and unlimited. A standard public
Linux runner has 4 CPUs, 16 GB RAM, and 14 GB SSD. For private repositories, the standard Linux
runner has 2 CPUs, 8 GB RAM, and 14 GB SSD and is `$0.006/min` after the account plan's included
minutes. GitHub rounds every job's partial minute up to a whole minute.
[GitHub runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[GitHub runner prices](https://docs.github.com/en/billing/reference/actions-runner-pricing)

Private-repository allowances are 2,000 minutes/month for GitHub Free personal and organization
accounts, 3,000 for Pro and Team, and 50,000 for Enterprise Cloud. They reset each billing cycle;
larger runners cannot consume them.
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

A 4-core larger Linux runner has 16 GB RAM and 150 GB SSD and costs `$0.012/min`. Larger runners
cannot use included minutes and remain billable for public repositories.
[GitHub larger runner specifications](https://docs.github.com/en/actions/reference/runners/larger-runners),
[GitHub runner prices](https://docs.github.com/en/billing/reference/actions-runner-pricing)

GitHub includes 10 GB of cache storage per repository. Additional configured cache storage is
`$0.07/GB-month`, accrued hourly from peak usage; unused entries are normally evicted after seven
days. Artifact storage is a separate `$0.25/GB-month` after plan allowances.
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
[GitHub cache limits and eviction](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

For Runway's own public repository, the direct GitHub compute comparison is therefore `$0`, not
GitHub's private-repository list price. Runway can target lower latency, stronger workflow
semantics, and favorable private-repository unit economics, but cannot honestly claim a lower
compute bill for this public repository.

### Depot

Depot's Linux x64 and Arm GitHub Actions runners range from 2 vCPU/8 GB at `$0.004/min` to
64 vCPU/256 GB at `$0.128/min`; a 4 vCPU/16 GB runner is `$0.008/min`. Runner use is measured by
the second, aggregated into billed minutes, with no one-minute minimum per run.
[Depot runner types](https://depot.dev/docs/github-actions/runner-types),
[Depot pricing](https://depot.dev/pricing)

The Developer plan is `$20/month` and includes 2,000 base runner minutes and 25 GB of cache. The
Startup plan is `$200/month` and includes 20,000 base minutes and 250 GB of cache. Additional cache
storage is `$0.20/GB-month`, measured from hourly snapshots averaged over the month. Larger runners
consume included minutes through size multipliers. Depot advertises a seven-day trial but no
ongoing free allowance for public repositories.
[Depot pricing](https://depot.dev/pricing),
[Depot Cache pricing](https://depot.dev/docs/cache/overview)

Depot's public pages do not state an egress price. “No network limits” is not a contractual claim
of free egress, so a procurement comparison needs written confirmation.

### Blacksmith

Blacksmith's Ubuntu x64 runners provide 2 vCPU/8 GB/80 GB at `$0.004/min`, with larger sizes
consuming proportionally more normalized 2-vCPU minutes; the implied 4 vCPU/16 GB price is
`$0.008/min`. It includes 3,000 x64 2-vCPU-equivalent minutes per organization per month. Arm,
Windows, macOS, and larger machines consume that allowance at documented multipliers.
[Blacksmith runner specifications and allowances](https://docs.blacksmith.sh/blacksmith-runners/overview),
[Blacksmith pricing](https://www.blacksmith.sh/pricing)

Blacksmith's current pages say “per minute” but do not document per-job rounding, per-second
metering, or a minimum duration. That billing granularity must be confirmed rather than inferred.
The live pricing page says Ubuntu x64 is 33% cheaper than GitHub, while the runner documentation
still says exactly half the price; use the explicit live dollar prices rather than either slogan.

Transparent Actions cache has no separate charge and includes 25 GB per repository. Sticky disks,
Docker layer caches, and cached container-image disks cost `$0.50/GB-month` and expire after seven
inactive days. [Blacksmith Actions cache](https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions),
[Blacksmith sticky disks](https://docs.blacksmith.sh/blacksmith-caching/dependencies-sticky-disks),
[Blacksmith Docker cache](https://docs.blacksmith.sh/blacksmith-caching/docker-builds)

Blacksmith does not publish network-egress pricing. Its “2x faster” and total-savings numbers are
provider estimates, not guarantees for a particular repository.

### What can and cannot be compared

The closest nominal four-core list-price comparison is:

| Provider/product                 | Nominal compute       |                                         Public list price | Important qualification                                                            |
| -------------------------------- | --------------------- | --------------------------------------------------------: | ---------------------------------------------------------------------------------- |
| Runway / Cloudflare `standard-4` | 4 vCPU, 12 GiB, 20 GB | about `$0.006684/active min` at full CPU after allowances | Derived from three usage meters; plus $5 account minimum and orchestration/storage |
| GitHub larger Linux              | 4 CPU, 16 GB, 150 GB  |                                              `$0.012/min` | Whole-minute job rounding; always paid                                             |
| GitHub standard public Linux     | 4 CPU, 16 GB, 14 GB   |                                                      `$0` | Public repositories only                                                           |
| Depot Linux                      | 4 vCPU, 16 GB         |                                              `$0.008/min` | $20/$200 base plan with included minutes; per-second metering                      |
| Blacksmith Linux                 | 4 vCPU, 16 GB, 80 GB  |                                      implied `$0.008/min` | 3,000 normalized free minutes; rounding unspecified                                |

Nominal vCPU counts are not performance units. CPU generation and sharing, local disk latency,
usable RAM, image/tool preinstallation, network topology, cache warmth, startup latency, and job
rounding all affect delivered work per dollar. Depot reserves some memory for RAM-disk acceleration;
Blacksmith uses bare-metal gaming CPUs; Cloudflare does not publish a CPU model for each Container
placement. A defensible comparison requires measured work completed, not cost per nominal vCPU.

The providers also bundle different surfaces. GitHub, Depot, and Blacksmith include the Actions
runner protocol, images, logs, and varying cache integrations. Runway's Cloudflare cost is split
across Workers, Workflows, Durable Objects, Containers, logs, and R2. Enterprise support, egress,
regional surcharges, and negotiated commitments are not fully public. No single all-in public price
can be calculated without a concrete monthly workload and measured cache behavior. GitHub measures
storage in binary GB (`2^30` bytes); the compared vendor pages label several dimensions only as
`GB`, so even nominal storage units should not be assumed identical. GitHub, Depot, and Blacksmith
do not publish a separately comparable standard-runner egress line item.

## Cloudflare primitives Runway can use

Cloudflare Sandboxes retain files only while their container is active. After inactivity or
destruction, the next container starts from its image and prior filesystem state is gone.
[Sandbox lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/)

Cloudflare now provides two persistence mechanisms:

- `mountBucket()` mounts R2 or another S3-compatible bucket at a path. Cloudflare recommends narrow
  mounts, read-only mode where possible, and copying frequently accessed files to local storage.
  Mounting over `/workspace` overlays existing contents and is discouraged for project persistence.
  [Sandbox bucket mounts](https://developers.cloudflare.com/sandbox/guides/mount-buckets/)
- `createBackup()` and `restoreBackup()` create squashfs snapshots in R2 and restore them through a
  copy-on-write overlay. A backup handle can be reused across multiple sandboxes and can carry a
  TTL. The production overlay must be restored again after a container restart.
  [Sandbox backup and restore](https://developers.cloudflare.com/sandbox/guides/backup-restore/),
  [backup/restore announcement](https://developers.cloudflare.com/changelog/post/2026-02-23-sandbox-backup-restore-api/)

The backup API is promising for tool-install trees and trusted repository baselines, but it is new.
Cloudflare describes the current implementation as FUSE-based and says lower-level native snapshots
are planned. It should be benchmarked before becoming Runway’s only transport.
[Cloudflare backup/restore announcement](https://developers.cloudflare.com/changelog/post/2026-02-23-sandbox-backup-restore-api/)

R2 is strongly read-after-write consistent and exposes conditional writes and checksums. Runway can
therefore make cache bodies immutable and update aliases/manifests with explicit preconditions rather
than relying on last-write-wins.
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[R2 Workers API conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

The current public `r2.dev` bootstrap endpoint should not become the production design. Cloudflare
marks `r2.dev` as rate-limited and intended for development; production caching and access controls
require a custom domain. [R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)

Container placement can be constrained by region, and R2 location hints can place storage nearer
expected readers, but hints are best-effort. Runway should measure region pairings rather than
assume co-location. [Container placement](https://developers.cloudflare.com/containers/platform-details/placement/),
[R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)

## Cloudflare Artifacts: provisional private-beta assessment

Cloudflare Artifacts is a Git-compatible, versioned filesystem currently described by Cloudflare as
a private beta. The April 2026 announcement mentioned a targeted public beta in early May, but the
June changelog still directs users to enroll in the beta. Runway should therefore treat every API,
limit, price, and implementation detail below as provisional until Cloudflare publishes a stable
availability and compatibility contract. [Artifacts changelog](https://developers.cloudflare.com/changelog/product/artifacts/),
[Artifacts announcement](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)

### Confirmed beta surface

- A namespace contains isolated repositories. Each repository has its own Git history, refs, remote,
  repository-scoped tokens, and durable lifecycle; a fork starts an independent repository from
  existing history. Cloudflare says one logical repository is routable from any region and is
  synchronously replicated across multiple data centers, with asynchronous object-storage
  snapshots. [How Artifacts works](https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/)
- The control surfaces are a Workers binding and REST API. The data plane is Git Smart HTTP. The REST
  API can create, list, inspect, delete, fork, and import repositories and can read commits, trees,
  blobs, and files. Reads can resolve immutable Git SHA-1 object IDs or a branch, tag, or commit.
  Repository tokens are read- or write-scoped, with documented TTLs from 60 seconds to one year.
  [Artifacts repositories](https://developers.cloudflare.com/artifacts/concepts/repositories/),
  [Artifacts REST API](https://developers.cloudflare.com/artifacts/api/rest-api/),
  [Artifacts Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/)
- Git clone/fetch supports protocol v1 and v2; push supports v1 only. The beta does not support v2
  `receive-pack`, and documented v1 omissions include `filter` and `include-tag`. Consumers must not
  assume every existing Git client optimization is available.
  [Artifacts Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/)
- ArtifactFS is an open-source FUSE client that performs a blobless clone, mounts the repository,
  hydrates file contents on demand, and caches them locally. Cloudflare positions it for large
  repositories in sandboxes, containers, and VMs; ordinary clone remains simpler for smaller
  repositories. Cloudflare also documents a Sandbox pattern that assigns one repository per sandbox
  ID and supplies a short-lived authenticated remote.
  [ArtifactFS](https://developers.cloudflare.com/artifacts/guides/artifact-fs/),
  [Sandbox SDK example](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/)
- Repository and Git operations can emit events to Workers, and per-operation counts, latency
  percentiles, and errors are queryable through the GraphQL Analytics API.
  [Artifacts event subscriptions](https://developers.cloudflare.com/artifacts/guides/event-subscriptions/),
  [Artifacts metrics](https://developers.cloudflare.com/artifacts/observability/metrics/)

The announcement says the beta implementation uses Durable Objects, a Zig/Wasm Git engine, SQLite
for Git data, R2 for snapshots, and KV for authentication tokens. These are implementation notes,
not a supported storage contract that Runway should couple to.
[Artifacts announcement](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)

### Published beta limits and pricing

The current limits are 10 GB per repository and 1 TB per account, with higher limits available by
request; repository and namespace counts are documented as unlimited. Both the control plane and
Git plane have a documented rate limit of 2,000 requests per ten seconds, scoped per namespace and
per repository respectively. [Artifacts limits](https://developers.cloudflare.com/artifacts/platform/limits/)

Artifacts is unavailable on Workers Free. Workers Paid includes 10,000 operations and 1 GB-month of
storage per month; published overage is `$0.15/1,000` operations and `$0.50/GB-month`. Storage uses
the average daily peak over a 30-day month, replicas are not separately charged, and repositories
remain billable until explicitly deleted. The docs publish no separate data-transfer charge, but
that absence is not a promise of free transfer. [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/)

Cloudflare documents global routing and multi-data-center replication, but the Artifacts docs do
not currently specify placement controls, jurisdiction/data-residency guarantees, regional latency
SLOs, transfer accounting, or region-to-Sandbox affinity. Those facts must remain unknown rather
than inferred from R2 or Durable Objects behavior.

### Runway implications (inference)

Artifacts is a plausible **Phase 5 repository-acceleration Source implementation**: Runway could
maintain a repository mirror, address exact commits, fork isolated working state, and evaluate
ArtifactFS for lazy source hydration. It is not a replacement for Cache. Git repositories expose
histories and mutable refs; Runway caches require immutable byte objects, runtime-derived trust
scopes, success-only publication, conditional aliases, direct transfer, retention, and cache-specific
authorization.

Runway should keep any future Artifacts implementation behind Source rather than put beta bindings
into the private cache plane. That preserves R2-backed cache objects and lets Phase 5 compare three
independent source paths: normal exact-SHA clone, a bare mirror or trusted snapshot, and
Artifacts/ArtifactFS. No package-manager, language-runtime, or tool-protocol semantics belong in
either Source or Cache.

Artifacts could later preserve agent/session filesystem histories in Phase 7, but that should not
pull deferred agent scope into the CI milestones. Repository tokens and forks are useful isolation
primitives, yet Runway must still own trusted-default-branch promotion, PR/fork policy, cache
poisoning defenses, secret exclusion, and fail-open correctness.

### Unknowns and adoption gates

Before Artifacts can enter Runway's source reconstruction path, Cloudflare must clarify or Runway
must prove:

- general availability, API/version compatibility, support expectations, and final billing;
- private-origin import and ongoing mirror synchronization, including GitHub App installation-token
  integration and exact delivery-SHA availability—the documented import accepts a public HTTPS
  remote and is not documented as a continuous mirror;
- ArtifactFS and FUSE compatibility in the managed runner image, cold and warm hydration latency,
  local-cache loss after Sandbox replacement, exact-SHA checkout, offline/failure behavior, and
  cleanup;
- push/ref concurrency, repository consistency during simultaneous fetch and update, garbage
  collection, retention, backup/restore, and disaster-recovery contracts;
- regional placement, data residency, transfer charging, quotas at expected repository sizes, and
  whether the operation model is cheaper than R2 plus ordinary Git for CI access patterns;
- a normal exact-SHA clone fallback for every miss, beta outage, unsupported Git capability, or
  ArtifactFS failure.

## Minimal language-neutral cache primitives

The provider evidence does not justify a package-manager-specific cache core. The public reusable
surface is one generic caller-named filesystem tree through `run.cache()`. Immutable content,
conditional refs, transfer capabilities, trust, schema, and publication remain private implementation
facts; language and build tools remain consumers or later adapters.

### Immutable content objects

Store bodies under a cryptographic digest and never mutate an existing digest. The object metadata
should record size, digest algorithm, media/schema version, producer, and creation time. R2 is
strongly read-after-write consistent, can validate a supplied SHA-256 on `put()`, and supports
conditional writes. [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

The conceptual API is:

```text
stat(digest) -> metadata | miss
beginPutIfAbsent(digest, size, checksum) -> direct upload capability | already-present
beginGet(digest) -> direct download capability | miss
```

### Conditional named references

Human/tool keys such as `latest trusted main`, a package-manager key, or a snapshot fingerprint
should be small refs pointing at immutable content. Update a ref only when its expected prior
version/ETag still matches. R2's conditional `put()` is sufficient for a single-ref compare-and-set;
a Durable Object is only needed when Runway requires multi-object transactions, queues, leases, or
serialized policy beyond that primitive.

```text
resolve(scope, name) -> { targetDigest, version } | miss
compareAndSet(scope, name, expectedVersion, targetDigest, metadata) -> committed | conflict
```

### Trust and policy

Authorization is separate from storage. Every capability must bind account, repository, cache
family, trust scope, operation, object/ref, and a short expiry. Default-branch trusted runs may
advance trusted refs; PRs may read eligible trusted refs but write only their isolated scope; fork
policy may remove even read access. GitHub independently applies this read-trusted/write-isolated
model to protect default-branch caches from low-trust triggers.
[GitHub cache security](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

### Direct transfer

Large cache bodies should travel directly between the Sandbox and object storage, not
through Worker memory or RPC streams. R2 presigned URLs authorize one operation on one object for
1 second to 7 days and work as ordinary HTTP uploads/downloads. They are bearer tokens and should
therefore be short-lived and narrowly scoped.
[R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

Cloudflare's own Sandbox backup implementation follows this pattern: the container creates a
squashfs archive and transfers it directly to/from R2 using a presigned URL.
[Sandbox Backups API](https://developers.cloudflare.com/sandbox/api/backups/)

### Safe filesystem cache implementation

Runway's first Cache consumer is a private content-addressed SquashFS encoding, not a public snapshot
manager. Restore stages beside the target, validates the complete tree under bounded descriptor-
relative traversal, and atomically renames only after integrity and target checks pass. Exact Source
reconstruction remains independent of Cache availability.

Cache schema 2 and runner ABI `runway-sandbox-v2` include a bounded canonical private hardlink-map
trailer in the archive/object digests. The pinned image exposes high-level `squashfuse`, whose stat
path does not preserve usable inode identity; the trailer allows Runway to validate exact regular-file
membership and recreate hardlinks without parsing compressed SquashFS metadata. A future pinned image
with equivalent low-level inode evidence may remove the trailer only behind another schema/ABI miss.

Cloudflare backups remain a benchmark alternative because they provide compressed SquashFS,
direct R2 transfer, TTLs, and copy-on-write restores. Their restored FUSE overlay is ephemeral after
Sandbox replacement and backup IDs are UUIDs rather than Runway content identities, so they do not
replace current cache semantics. [Sandbox Backups API](https://developers.cloudflare.com/sandbox/api/backups/)

### Success-only publication

Uploads are staged and verified while a run is executing, but a shared named ref is advanced only
after the producing command/job succeeds and policy allows the promotion. Failure or cancellation
leaves immutable unreferenced bodies for lifecycle cleanup. GitHub creates a missed cache only when
the job completes successfully; Blacksmith commits Docker cache changes only after an otherwise
successful, non-cancelled job.
[GitHub dependency cache](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching),
[Blacksmith Docker cache](https://docs.blacksmith.sh/blacksmith-caching/docker-builds)

```text
stage immutable bodies
verify digests and snapshot metadata
on success: authorize + compare-and-set named refs
on failure/cancel: publish no shared refs
```

These five pieces—immutable content, conditional refs, policy, direct transfer, and safe generic
filesystem trees with success-only ref publication—are enough to support later ecosystem packages,
repository mirrors, tool-native protocols, and BuildKit without teaching the cache core any
language-specific invalidation rules.

## Existing cache semantics worth adopting

### GitHub Actions

GitHub cache entries are immutable: changing content requires a new key. Lookup uses exact key and
version, then prefix restore keys, first in the current branch and then the default branch.
[GitHub dependency cache](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

GitHub’s security rules are more important than its archive format:

- Default-branch caches are writable only by trusted trigger types.
- Pull-request caches are scoped to the PR merge ref.
- Low-trust runs may restore trusted default-branch caches but cannot overwrite them.
- Cache contents are unsigned and may execute after restoration, so secrets must never be cached.

Runway should reproduce the trust boundary, not merely key matching.
[GitHub cache security](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

GitHub’s `setup-node` caches package-manager global stores rather than `node_modules`, allowing reuse
across Node versions while retaining an explicit install step.
[actions/setup-node](https://github.com/actions/setup-node/blob/main/README.md)

### BuildKit

BuildKit keeps local cache inside a builder and supports external cache import/export. Cache mounts
are cumulative package stores; layer cache is keyed by Dockerfile instructions and relevant input
metadata. [Docker cache optimization](https://docs.docker.com/build/cache/optimize/),
[BuildKit cache backends](https://docs.docker.com/build/cache/backends/)

BuildKit reinforces two Runway design choices:

- Package stores and final output layers are different cache families.
- Concurrent mutable cache mounts may require locking, while immutable build outputs can use content
  addressing.

Docker secrets must use secret/SSH mounts rather than `ARG` or copied files, because build inputs
and cached layers can otherwise leak them.
[Docker build secrets](https://docs.docker.com/build/building/secrets/)

### Turborepo and Nx

Turborepo caches declared task outputs and logs under hashes computed from task definitions,
lockfile state, files, environment inputs, and arguments. Its remote protocol can be self-hosted,
and optional HMAC-SHA256 signatures cause unverifiable artifacts to be treated as misses.
[Turborepo caching](https://turborepo.dev/docs/crafting-your-repository/caching),
[Turborepo remote cache](https://turborepo.dev/docs/core-concepts/remote-caching)

Nx stores input hashes, declared output files, and terminal output. Nx warns that correctness
depends on complete input/output declarations. Its managed cache makes entries immutable and
supports read/write access controls and PR-isolated writes. Nx 20.8+ also documents a self-hosted
HTTP cache protocol. [Nx remote cache](https://nx.dev/docs/features/ci-features/remote-cache),
[Nx cache security](https://nx.dev/docs/concepts/ci-concepts/cache-security),
[Nx self-hosted protocol](https://nx.dev/docs/guides/tasks--caching/self-hosted-caching)

Runway should transport these protocols instead of building its own dependency graph. A Turborepo
adapter can configure a Runway-compatible remote endpoint and scoped token; an Nx adapter can do
the same for Nx’s native protocol.

## Recommended Runway architecture

This section is inference from the verified behavior above, not a claim about existing provider
implementation.

### Internal concept: Sandbox

A **Sandbox** is the run-scoped internal owner that:

- reconstructs an exact repository commit;
- restores eligible caches;
- runs commands;
- publishes eligible cache changes;
- survives workflow retries through deterministic identity;
- is cleaned up at run completion.

Authors do not receive this object. They use `Run`; Cloudflare Sandbox stays behind the internal
Sandbox boundary.

### Internal cache plane

Use private R2 for immutable objects. Keep refs and policy in the repo-scoped control plane, and do
not proxy payload bodies through authored workflow code.

A cache identity should include at least:

```text
account
repository
cache kind
trust scope
runner image digest / ABI
OS, architecture, libc
producer tool and version
input digest
schema version
```

Store bodies by digest. Use conditional writes for mutable aliases such as “latest trusted main
baseline.” Never overwrite a body at an existing digest.

Every cache implementation should follow the same lifecycle semantics internally:

```text
fingerprint → lookup → restore/mount → validate → use → publish-on-success
```

A miss, corrupted object, timeout, or unavailable cache must fall back to normal execution. Cache
correctness cannot be required for workflow correctness.

The public interface is now deliberately smaller than a universal store: `run.cache()` declares one
named path and caller-owned key. R2 objects, refs, manifests, transfer capabilities, archive encoding,
and snapshot helpers remain internal. Package managers and language runtimes prove only that the same
language-neutral tree semantics work; they do not enter foundation vocabulary.

Three roles should not be collapsed under the word adapter:

- a **runtime adapter** connects the repository-sandbox interface to Cloudflare Sandbox;
- a **snapshot-storage adapter** restores/publishes immutable content or named filesystem state;
- a **cache-protocol adapter** lets an existing tool such as Turborepo or Nx speak to Runway's cache
  plane while retaining its own hashes and graph;
- a future **workflow action** is an author-visible reusable command bundle.

An imperative setup action would remain a completed workflow step and would not repair state after
Sandbox replacement. Public syntax should wait until the internal placement/cache seams and at
least two enduring storage implementations are proven.

### Separate cache families

| Cache family           | Example contents                        | Correct key                                                      | Publication policy                              |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| Tool environment       | OCI runner image                        | immutable image digest, Sandbox compatibility, architecture, ABI | Immutable; deploy-authorized producer           |
| Dependency store       | pnpm/npm/Cargo download store           | manager/version, lockfile, platform where necessary              | PR-isolated writes; trusted main may promote    |
| Installed dependencies | `node_modules`, virtualenv              | all manifests, lockfile, installer flags, scripts, toolchain ABI | Opt-in; trusted baseline only initially         |
| Repository mirror      | bare Git objects                        | repository identity and object format                            | Incremental fetch; no credentials persisted     |
| Workspace baseline     | exact trusted source plus prepared deps | trusted base SHA plus all adapter fingerprints                   | Short TTL; never published by untrusted PR code |
| Task outputs           | Turbo/Nx outputs and logs               | tool-computed task hash                                          | Immutable; scoped write token/signature         |
| BuildKit               | layers, cache mounts, pulled images     | repository, Dockerfile/build target, architecture, builder ABI   | Separate quota and concurrency policy           |

### Trust model

Use three scopes:

- `trusted/<default-branch>`: writable only by protected/default-branch push or an explicitly
  trusted warmer.
- `pr/<number or merge-ref>`: writable only by that PR’s runs.
- `content/<digest>`: globally deduplicated bytes whose accessibility remains
  repository-authorized.

PR runs may read trusted base caches when those caches contain no secrets, but cannot update
trusted aliases. Fork PRs should initially get restore-only or fully isolated access depending on
repository policy.

Publish only after the relevant command/job succeeds. Never cache credentials, `.npmrc` tokens, Git
installation tokens, secret-bearing environment snapshots, or user home state. Cache credentials
should be short-lived and scoped to repository, cache family, operation, and trust namespace.

Content hashes verify integrity, not producer trust. Writer authorization remains mandatory.

## Proactive warming strategy

Runway can warm predictable state without predicting arbitrary build outputs:

1. At deploy, resolve and verify the immutable runner image and its Sandbox compatibility. Pre-pull
   only if the feasibility spike proves Cloudflare exposes a real influence point.
2. On a trusted default-branch success, asynchronously publish:
   - updated Git mirror;
   - package-manager store;
   - optionally a prepared dependency/workspace baseline.
3. At webhook admission, begin repository-sandbox startup immediately and fetch independent cache
   manifests in parallel.
4. Restore repository objects and independent named snapshots concurrently where Cloudflare’s APIs
   permit.
5. Continue naturally populated Turborepo/Nx caches; their input hashes decide reuse.
6. Later, prehydrate commonly used container images and BuildKit state.
7. Keep warmers advisory. Normal exact-SHA reconstruction must always work without them.

## Measurement contract

Before optimizing, add timings and cache telemetry for:

- webhook-to-admission;
- queue and container cold start;
- exact-SHA checkout;
- each cache lookup;
- bytes restored/published;
- restore/extract/mount duration;
- dependency installation;
- each command;
- cleanup;
- hit, miss, partial hit, validation failure, and fail-open reason.

Benchmark at least these scenarios:

1. empty cache;
2. hot unchanged main;
3. source-only PR change;
4. lockfile/tool change;
5. cache service unavailable;
6. concurrent runs with the same key;
7. cancelled producer;
8. untrusted fork PR;
9. forced Sandbox replacement.

Use repeated P50/P95 measurements, identical commits, and the same workflow commands. Keep
CPU-heavy, I/O-heavy, and cache-heavy results separate. Compare Runway `standard-4` against
GitHub’s four-core public Linux runner. The live legacy half-core runner is useful exact-head
development evidence, but it is not valid final performance evidence for the desired four-core
manifest.

The target should be precise: for example, “Runway warm source-only PR checks have lower
webhook-to-completion P50 and P95 than GitHub-hosted Actions for the benchmark repositories,” not
“Runway is always faster.”

### Illustrative ten-minute workload model

This is a target model, not a measured result. Assume one private four-core GitHub job takes ten
minutes. At current list prices it costs `$0.12`; the same ten-minute wall time costs `$0.08` on
Depot or Blacksmith's nominal four-core tiers and about `$0.06684` on a fully utilized Cloudflare
`standard-4`, before fixed-plan, orchestration, cache storage, and egress adjustments.

If the foundation works, Runway should target:

| Runway scenario                  | Target wall time | Derived `standard-4` container cost at full CPU | What creates the win                                           |
| -------------------------------- | ---------------: | ----------------------------------------------: | -------------------------------------------------------------- |
| Cold; no reusable state          |         9–11 min |                                 `$0.060–$0.074` | Comparable compute and low admission overhead                  |
| Warm generic filesystem snapshot |          5–6 min |                                 `$0.033–$0.040` | Source/dependency state transfer replaces repeated preparation |
| Later tool-native output hit     |          1–2 min |                               `$0.0067–$0.0134` | Tool-owned work is safely skipped                              |

The warm targets are deliberately aggressive release gates. They do not imply that every workload
is cacheable or that Cloudflare's vCPU matches another provider's CPU. The cold benchmark prevents
caching from hiding weak compute; every warm benchmark must include transfer, validation, extraction,
storage, orchestration, and miss cost. For public repositories, standard GitHub compute remains free,
so Runway competes on feedback time and capability rather than direct compute price.

## Foundation milestones and remaining gates

### Phase 1 — runner foundation and subtraction

- Delete the unused private cache route and consolidate repeated live Cloudflare resource ownership.
- Establish a run-bound `Sandbox` behind flat `Run` operations plus one Terminal authority.
- Reconstruct source only before any command may have started. After an acknowledged or ambiguous
  start, reconnect only to the proven same process/placement; otherwise fail explicitly rather than
  replaying a command that may have mutated workspace or external state.
- Keep the current dogfood archive isolated; do not create an archive framework around it.
- Instrument admission, container, checkout, command, reconnect, placement loss, finish, cleanup, and
  raw billable resource dimensions.
- Benchmark generic CPU, I/O, source, cancellation, and replacement workloads on comparable
  Cloudflare and GitHub capacity.

Local status: the execution lifecycle and Meter exist; the comparable cold-path benchmark remains an
open release gate.

### Phase 2 — content cache foundation

- Define runtime-derived trusted/default, PR, and fork scopes; forks default isolated/read-only.
- Implement repository-private immutable content objects plus conditional named refs and publish only
  with the durable winning success grant.
- Keep metadata/control in Worker/Durable Object while large bytes transfer directly Sandbox↔storage
  through short-lived capabilities; prove commands cannot observe or reuse credentials.
- Make lookup, transfer, validation, conflicts, bytes, and cost observable; skip work above explicit
  time/cost/size budgets.
- Benchmark direct R2 transfer against Cloudflare backup/restore before introducing a storage seam.
- Add retention/quota/GC and proactive lookup only after lifecycle and cost measurement.

Local status: private identity, refs, policy, observability, budgets, and success-only publication are
implemented. Repeatable direct private-R2 live evidence remains open.

### Phase 3 — safe filesystem snapshots and dogfood deletion

- Build one generic filesystem-snapshot consumer over the content cache; callers supply every key and
  path.
- Canonicalize roots; forbid Git/control/credential paths, traversal, devices/FIFOs, escaping links;
  bound bytes/files/time/disk; stage, atomically commit, and clean corrupt/partial restores.
- Restore on the initial placement, or a replacement proven to occur before any command may have
  started, and publish during successful `finish`.
- Prove semantics with synthetic arbitrary trees, then external Node, Python, and Rust fixtures; no
  ecosystem name, default, or invalidation rule enters foundation source.
- Add trusted-main warming, isolated PR writes, fork policy, singleflight, and conditional publication.
- Once repeated cold/warm/replacement evidence is green, replace and delete Runway's temporary public
  archive, Dockerfile, hashes, shell transport, tool probes, and public bucket configuration.

Local status: generic schema-2 trees and Runway's repository-only consumer exist. The old public
bootstrap cannot be deleted until live miss/publish/warm/corrupt/cancel evidence passes.

### Phase 4 — runner environments, capacity, and comparable performance

- Run a disposable default/Python/Rust image feasibility spike, treating them only as compatibility
  fixtures; record the control-server, entrypoint, identity, registry, protocol, and rollout facts.
- Publish the smallest profile/capacity contract only after an ADR proves safe versioning through
  versioned applications/routing or a race-free all-trigger admission/drain protocol.
- Compare cold and warm workloads at equal capacity and report wall time and total cost together.
- Measure whether Runway can influence image pre-pull; do not claim an unavailable primitive.

Exit: generic environment/capacity choices have measured price and latency characteristics.

### Phase 5 — repository acceleration

- Benchmark ordinary exact clone, a repository bare Git mirror, a trusted-main Cloudflare backup,
  and Artifacts/ArtifactFS once a stable accessible beta contract exists.
- Measure full and lazy hydration, full-tree scans, incremental fetches, forks, exact-SHA verification,
  concurrency, credentials, cleanup, operations, stored bytes, and total cost.
- Fetch only missing objects, never persist credentials, and fall back to exact filtered clone for
  every miss, outage, unsupported operation, or failed experiment.

Exit: the fastest cost-effective implementation sits behind the repository-source seam; Artifacts is
adopted only if repeated P50/P95 and total-cost evidence wins a declared workload.

### Phase 6 — tool-native cache transports

- Add authenticated Turbo, Nx, sccache, Bazel-compatible, or similar protocols only for real users.
- Preserve tool-owned hashes, graphs, signatures, and validation.
- Package thin reusable declarations/actions separately from the cache core.
- Require repeated cold/hit/partial/corrupt/unavailable P50/P95 and measured/derived per-run cost to
  meet the tool-native release target before shipping each transport.

Exit: build outputs use native protocols; Runway does not become a build-graph system.

### Phase 7 — BuildKit, pulled images, and agent workloads

- Treat BuildKit layers/cache mounts and pulled images as separate quota/concurrency families.
- Benchmark rootless Docker-in-Docker and external BuildKit cache against prebuilt runner images.
- Reuse repository-sandbox isolation, snapshot policy, and observability for later agent sessions;
  evaluate per-session Artifacts histories/forks separately from the CI source path.

Exit: Docker-heavy CI and future agents reuse the same foundation without weakening isolation.

## Simplification test

The phase succeeds when Runway’s own workflows read approximately like:

```ts
export default workflow({
  id: "check",
  trigger: () => github({ ... }),
}).run(async (run) => {
  await prepareRepository(run);
  await run.exec("typecheck", repositoryCommand("pnpm typecheck"));
  await run.exec("lint", repositoryCommand("pnpm lint"));
  await finishRepository(run);
});
```

The foundation public syntax is now flat `run.do/exec/cache/sleep`. This repository's helper is an
ordinary consumer, not a foundation preset: it may contain Node and pnpm details while cache
transport, trust scope, capability handling, validation, and atomic restore stay internal. Future
adapters should be introduced only when a second real consumer proves a reusable seam.
