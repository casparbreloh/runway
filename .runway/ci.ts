const cacheUrl = "https://pub-13f36f9056c9471c9141c9b25d2c6069.r2.dev/caches";
const cacheParts = [
  "1a38d59ea4107e010fd8b6a2ae5262668b0606d9196218e9addbf54d5fed5de9",
  "935f72550fb8312d795f3f65bb04a74f0a4b9c253a7c4b0f27c1723206b183c1",
  "23968e28076c056b779a8e8c907e571e104f0a9404f236f4a2828cc15889b113",
  "8b15947729ce7ba33b306eefce8ce99d4159c0825ecbd3cdd7bf3d481da0c3e1",
  "6e61fc8ed834dcf35eef90eb8637e5298be49d825fca11076ec5353698b84910",
  "cc38aa82ceb7604ec9e9a638a5900f70dddb9b9ef3ef6fbd019b37a2063d4500",
  "531d4f7f3d33a58e408aab8a3d9c8a28439b6305235cac956e0bf726e4c4ec15",
] as const;
const cacheArchive = "4c7beaf69cf9508c416339cfc7ce42357903ee935875102e1451fcbbb5840235";
export const lockfile = "6b0c2ddcbf7d1d54754462700d7854b91ab3fd858d32bd352ec331d5d6585cf3";

const downloads = cacheParts.map(
  (digest, index) =>
    `curl --retry 3 --retry-all-errors --connect-timeout 10 --max-time 600 -fsSL ${cacheUrl}/${digest}.tar.gz -o /tmp/runway-ci-${index} && echo '${digest}  /tmp/runway-ci-${index}' | sha256sum --check --status`,
);

export const setupCiToolchain = `${downloads.join(" && ")} && cat ${cacheParts.map((_, index) => `/tmp/runway-ci-${index}`).join(" ")} > /tmp/runway-ci.tar.gz && echo '${cacheArchive}  /tmp/runway-ci.tar.gz' | sha256sum --check --status && tar -xzf /tmp/runway-ci.tar.gz -C / && ldconfig`;

export const installCiDependencies = `if echo '${lockfile}  pnpm-lock.yaml' | sha256sum --check --status; then test -d node_modules/.pnpm && test -e node_modules/runway; else NODE_OPTIONS=--max-old-space-size=128 pnpm install --frozen-lockfile --reporter=append-only --child-concurrency=1 --network-concurrency=16 --package-import-method=hardlink; fi`;
