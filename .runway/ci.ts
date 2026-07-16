const cacheUrl = "https://runway-monorepo.caspar-breloh-7f9.workers.dev/.runway/cache";
const cacheParts = [
  "d709bee14e9b8d3b676fe0c3016413624d117fe579d4b3d971de3396b76c64c7",
  "c57e20354a06146631467902a37b4b68b9a84048459dff1677e08eeb4e87c399",
  "ec2e97dc946ea18f3c79ecba96ce6afe8527a936ab76bfdcf8579048a9620dda",
] as const;
const cacheArchive = "28011ef1e8cace3b7dae44f4536dbd352dfebff620ee78b585aacdfc973ab5fe";
export const lockfile = "6b0c2ddcbf7d1d54754462700d7854b91ab3fd858d32bd352ec331d5d6585cf3";

const downloads = cacheParts.map(
  (digest, index) =>
    `curl --retry 3 --retry-all-errors --connect-timeout 10 --max-time 300 -fsSL ${cacheUrl}/${digest}.tar.gz -o /tmp/runway-ci-${index} && echo '${digest}  /tmp/runway-ci-${index}' | sha256sum --check --status`,
);

export const setupCiToolchain = `${downloads.join(" && ")} && cat /tmp/runway-ci-0 /tmp/runway-ci-1 /tmp/runway-ci-2 > /tmp/runway-ci.tar.gz && echo '${cacheArchive}  /tmp/runway-ci.tar.gz' | sha256sum --check --status && tar -xzf /tmp/runway-ci.tar.gz -C / && ldconfig`;

export const installCiDependencies = `if echo '${lockfile}  pnpm-lock.yaml' | sha256sum --check --status; then NODE_OPTIONS=--max-old-space-size=256 pnpm install --offline --frozen-lockfile --trust-lockfile --store-dir /opt/runway/pnpm-store --reporter=append-only --child-concurrency=1; else NODE_OPTIONS=--max-old-space-size=256 pnpm install --frozen-lockfile --reporter=append-only --child-concurrency=1 --network-concurrency=16; fi`;
