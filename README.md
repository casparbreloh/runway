# Runway

Launch coding-agent jobs from Linear issues or markdown plans, run them in a Cloudflare Sandbox,
and report back a GitHub draft PR (`pi`) or a Codex Cloud task URL (`codex-cloud`).

V1 is narrow: one Cloudflare Worker control plane, Cloudflare Sandbox as the only runtime,
two executors, Linear as the first source, a direct `POST /jobs` as the dev/markdown path.

## Layout

```
src/
  index.ts            Worker entry: routes, dispatch, job state
  types.ts            JobSpec / JobResult / Env
  sandbox.ts          SandboxRunner interface + Cloudflare impl + RecordingRunner fake
  linear.ts           Linear webhook -> JobSpec (verify + map)
  github.ts           draft PR create/update + comment
  executors/
    codex-cloud.ts     submit `codex cloud exec`, return task URL/ID
    pi.ts              clone -> plan -> pi -> validate -> push
  auth-handoff.ts     local auth probe / packager (dev helper)
scripts/              dry-run harnesses (codex-cloud-dry, pi-dry)
tests/                vitest unit tests
```

## Develop

```
npm install
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run probe:auth     # report which credentials are present (no secrets printed)
npm run codex-cloud:dry
npm run pi:dry
npm run dev            # wrangler dev (needs Docker for the container)
```

## Configure

Non-secret config lives in `wrangler.jsonc` → `vars` (`DEFAULT_EXECUTOR`, `DEFAULT_REPO`,
`GITHUB_OWNER`, `CODEX_CLOUD_ENV_ID`, `LINEAR_TRIGGER_STATE`, `LINEAR_TRIGGER_COMMENT`).

Secrets (copy `.dev.vars.example` → `.dev.vars` for dev, or `wrangler secret put <NAME>`):
`LINEAR_WEBHOOK_SECRET`, `RUNWAY_API_TOKEN` (gates `POST /jobs`), `GITHUB_TOKEN`,
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`.

Auth is bring-your-own: nothing is hosted for you. `npm run probe:auth` checks each credential;
`npm run probe:auth -- --package` writes a local, gitignored bundle for seeding a sandbox by hand.

## Endpoints

- `POST /webhooks/linear` — verified Linear webhook (HMAC signature + fresh timestamp required) → job.
- `POST /jobs` — submit a JobSpec directly (markdown/dev path). Requires `Authorization: Bearer $RUNWAY_API_TOKEN`; disabled if that secret is unset.
- `GET /jobs/:id` — job state.
- `GET /health` — liveness.

## Deploy

```
wrangler kv namespace create JOBS      # optional job-state store; paste id into wrangler.jsonc
wrangler secret put GITHUB_TOKEN       # ...and the other secrets
wrangler deploy
```

### Deploy-time checks (need a Cloudflare account + Docker + real creds)

- Sandbox runs the Codex Cloud submit command and stops.
- Sandbox runs a Pi job and stops.
  These can't run in CI without credentials; verify after `wrangler deploy` with a real repo.
