# Cloudflare Sandbox image for Runway. Tag MUST match @cloudflare/sandbox version.
FROM docker.io/cloudflare/sandbox:0.11.0

# The coding agent (pi) Runway invokes inside the sandbox.
# (git + node/npm ship in the base image; gh is added to open PRs.)
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
  && (command -v gh >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*) || true)

EXPOSE 8080
