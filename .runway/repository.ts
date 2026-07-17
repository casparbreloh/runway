import type { ExecOptions, Run } from "runway";

const toolchainRoot = "/cache/runway-ci-toolchain";
const dependencyStore = "/cache/runway-ci-pnpm-store";
const systemPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const environment = {
  LD_LIBRARY_PATH: `${toolchainRoot}/lib`,
  PATH: `${toolchainRoot}/node/bin:${toolchainRoot}/bin:${systemPath}`,
  pnpm_config_verify_deps_before_run: "false",
};

const setupToolchain = `set -eu
root=${toolchainRoot}
staging=${toolchainRoot}.staging
if test -x "$root/node/bin/node" && test -x "$root/bin/pnpm" && test -e "$root/lib/libatomic.so.1" && test "$("$root/node/bin/node" --version)" = "v26.5.0" && test "$(PATH="$root/node/bin:$root/bin:${systemPath}" "$root/bin/pnpm" --version)" = "11.5.0"; then
  exit 0
fi
rm -rf "$root" "$staging"
mkdir -p "$staging/node" "$staging/pnpm" "$staging/bin" "$staging/lib"
trap 'rm -rf "${toolchainRoot}.staging"' EXIT
curl --retry 3 --retry-all-errors --connect-timeout 10 --max-time 600 -fsSL https://nodejs.org/dist/v26.5.0/node-v26.5.0-linux-x64.tar.gz -o "$staging/node.tar.gz"
echo '22b5f47ad6ae78837e4c2b846019965ce1a06ba143de176102294a1bf44fc677  ${toolchainRoot}.staging/node.tar.gz' | sha256sum --check --status
tar -xzf "$staging/node.tar.gz" --strip-components=1 -C "$staging/node"
curl --retry 3 --retry-all-errors --connect-timeout 10 --max-time 600 -fsSL https://registry.npmjs.org/pnpm/-/pnpm-11.5.0.tgz -o "$staging/pnpm.tar.gz"
echo 'a282871708f87a47b9cd72182dfdf9ee251c69100b8bac862a3d4f5e2145d8ff  ${toolchainRoot}.staging/pnpm.tar.gz' | sha256sum --check --status
tar -xzf "$staging/pnpm.tar.gz" --strip-components=1 -C "$staging/pnpm"
chmod 755 "$staging/pnpm/bin/pnpm.cjs"
ln -s ../pnpm/bin/pnpm.cjs "$staging/bin/pnpm"
curl --retry 3 --retry-all-errors --connect-timeout 10 --max-time 600 -fsSL https://security.ubuntu.com/ubuntu/pool/main/g/gcc-12/libatomic1_12.3.0-1ubuntu1~22.04.3_amd64.deb -o "$staging/libatomic.deb"
echo '56573c81b5dd84817882400cfea49fe671f5e6cfdd0f88b5d3a894c08b150462  ${toolchainRoot}.staging/libatomic.deb' | sha256sum --check --status
dpkg-deb --extract "$staging/libatomic.deb" "$staging/libatomic"
cp -a "$staging/libatomic/usr/lib/x86_64-linux-gnu"/libatomic.so.1* "$staging/lib/"
rm -rf "$staging/node.tar.gz" "$staging/pnpm.tar.gz" "$staging/libatomic.deb" "$staging/libatomic"
test "$(LD_LIBRARY_PATH="$staging/lib" "$staging/node/bin/node" --version)" = "v26.5.0"
test "$(LD_LIBRARY_PATH="$staging/lib" PATH="$staging/node/bin:$staging/bin:${systemPath}" "$staging/bin/pnpm" --version)" = "11.5.0"
mv "$staging" "$root"
trap - EXIT`;

export const repositoryCommand = (
  command: string,
  options: Omit<ExecOptions, "command" | "env"> & {
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): ExecOptions => ({
  command,
  ...options,
  env: { ...environment, ...options.env },
});

export const prepareRepository = async (run: Run): Promise<void> => {
  await run.exec("setup-node", repositoryCommand(setupToolchain, { timeoutMs: 15 * 60_000 }));
  await run.exec("setup-pnpm", repositoryCommand("pnpm --version"));
  await run.exec("toolchain", repositoryCommand("node --version && pnpm --version"));
  await run.exec(
    "install",
    repositoryCommand(
      `pnpm install --frozen-lockfile --reporter=append-only --child-concurrency=1 --network-concurrency=16 --package-import-method=hardlink --node-linker=hoisted --store-dir ${dependencyStore}`,
      { env: { NODE_OPTIONS: "--max-old-space-size=128" } },
    ),
  );
};
