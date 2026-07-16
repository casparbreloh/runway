const cacheUrl = "https://runway-monorepo.caspar-breloh-7f9.workers.dev/.runway/cache";
const cacheParts = [
  "444aa69bb14ffb6659fdceed3d343cd7521ffafec067248286539d03bec2a08d",
  "6144ee12406861fb15c2b253ad9ad6d6eca41e53252cf60c87b93ccf1f8794cf",
  "304ec1ed951ec190621d2187f7077b60a2fc16390cc679f5e85155a8e9087bd8",
  "d523dd9620294ecf3b8822e57fec26c0b79b16d86b509f9f3c3c2d76fe5b8d95",
] as const;
const cacheArchive = "b24ece86ce267349525dc8c1cbaaf495c2246fd007d24245ce6051beef122fac";
export const lockfile = "6b0c2ddcbf7d1d54754462700d7854b91ab3fd858d32bd352ec331d5d6585cf3";

const downloads = cacheParts.map(
  (digest, index) =>
    `curl --retry 3 --retry-all-errors --connect-timeout 10 --max-time 300 -fsSL ${cacheUrl}/${digest}.tar.gz -o /tmp/runway-ci-${index} && echo '${digest}  /tmp/runway-ci-${index}' | sha256sum --check --status`,
);
const backgroundDownloads = downloads
  .map((download, index) => `(${download}) & runway_cache_${index}=$!;`)
  .join(" ");
const waitForDownloads = cacheParts.map((_, index) => `wait "$runway_cache_${index}"`).join(" && ");

export const setupCiToolchain = `${backgroundDownloads} ${waitForDownloads} && cat ${cacheParts.map((_, index) => `/tmp/runway-ci-${index}`).join(" ")} > /tmp/runway-ci.tar.gz && echo '${cacheArchive}  /tmp/runway-ci.tar.gz' | sha256sum --check --status && tar -xzf /tmp/runway-ci.tar.gz -C / && ldconfig`;

export const installCiDependencies = `if echo '${lockfile}  pnpm-lock.yaml' | sha256sum --check --status; then test -d node_modules/.pnpm && test -e node_modules/runway; else NODE_OPTIONS=--max-old-space-size=128 pnpm install --frozen-lockfile --reporter=append-only --child-concurrency=1 --network-concurrency=16 --package-import-method=hardlink; fi`;
