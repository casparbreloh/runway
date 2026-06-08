# Runway sandbox image: base runtime + pi + the prebuilt runner.
# Build context is this directory. `dist/` is built in the workspace (pnpm) before
# wrangler runs — see the root dev/deploy scripts.
FROM docker.io/cloudflare/sandbox:0.11.0

# Agent runs are long-lived; raise the per-command timeout above the default.
ENV COMMAND_TIMEOUT_MS=600000

WORKDIR /app
# pi is the runner's only runtime dependency. Keep this version in sync with the
# @earendil-works/pi-coding-agent pin in pnpm-workspace.yaml's catalog.
RUN npm install --no-save @earendil-works/pi-coding-agent@0.78.1
COPY dist ./dist

# No ENTRYPOINT/CMD: the base image's sandbox server stays the entrypoint. The
# Worker runs the agent on demand via `node /app/dist/runner.js <input> <result>`.
