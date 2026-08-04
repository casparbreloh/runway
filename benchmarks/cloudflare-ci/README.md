# Cloudflare CI benchmark

This is a standalone Cloudflare CI worker for comparing the same Runway checks against the
repository's Runway and GitHub Actions implementations.

The `install` runner is cached, then `check` and `test` run concurrently. The commands and
`VITEST_MAX_WORKERS=1` setting match `.runway/workflows/check.ts` and `test.ts`.

## Setup

Cloudflare Artifacts is a private beta. Create an Artifacts repository containing this repository,
then configure the namespace and repo names in `wrangler.jsonc`. The Artifacts repository must be
updated for each benchmark commit; an ordinary GitHub pull request does not trigger this worker.

```sh
npm install
npx wrangler deploy --var CLOUDFLARE_ACCOUNT_ID:<account-id>
```

The deployment also requires the `@cloudflare/ci` runner credentials described in Cloudflare's CI
SDK documentation (`CF_TOKEN`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`). Do not commit them.

Triggering an Artifacts push starts a Workflow instance. Record the event-to-terminal duration and
compare repeated cold and warm runs with the GitHub and Runway samples documented in
`.docs/research/ci-performance-and-cache-architecture.md`. This worker is deliberately isolated
from the repository's author-facing Runway workflows so the benchmark does not alter them.

Cloudflare CI cannot currently receive GitHub pull-request events or publish GitHub check results;
a bridge that mirrors a PR commit into Artifacts is required for a live PR comparison.
