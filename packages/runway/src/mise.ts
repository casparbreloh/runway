import { defineToolProvider, type ToolProvider } from "./tools.ts";

const VERSION = "v2026.7.7";
const SHA256 = "0953810c2785eb4a75159f67f8b5721c4f3c80b8a6a812015d5af7d7fbd1b8a4";
const ROOT = "/cache/runway/tools/mise";
const LIBATOMIC_SHA256 = "56573c81b5dd84817882400cfea49fe671f5e6cfdd0f88b5d3a894c08b150462";
const LIBATOMIC_URL =
  "https://security.ubuntu.com/ubuntu/pool/main/g/gcc-12/libatomic1_12.3.0-1ubuntu1~22.04.3_amd64.deb";
const CONFIG_FILES = [
  ".mise.toml",
  ".mise/config.toml",
  ".tool-versions",
  "mise.local.toml",
  "mise.lock",
  "mise.toml",
] as const;

export type MiseTools = Readonly<Record<string, string>>;

const shell = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const fingerprint = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
};

const inlineConfig = (tools: MiseTools): string => {
  const entries = Object.entries(tools).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) throw new Error("mise tools cannot be empty");
  for (const [name, version] of entries) {
    if (!name || name.includes("\0") || !version || version.includes("\0")) {
      throw new Error("mise tools must have non-empty names and versions");
    }
  }
  const config = `[tools]\n${entries.map(([name, version]) => `${JSON.stringify(name)} = ${JSON.stringify(version)}`).join("\n")}\n`;
  if (new TextEncoder().encode(config).byteLength > 384) {
    throw new Error("mise inline tools are too large");
  }
  return config;
};

export const mise = (tools?: MiseTools): ToolProvider => {
  const config = tools ? inlineConfig(tools) : undefined;
  const configPath = `${ROOT}/config.toml`;
  const url = `https://github.com/jdx/mise/releases/download/${VERSION}/mise-${VERSION}-linux-x64.tar.gz`;
  const install = [
    `mkdir -p ${shell(`${ROOT}/bin`)} ${shell(`${ROOT}/data`)} ${shell(`${ROOT}/cache`)} ${shell(`${ROOT}/lib`)}`,
    `if [ ! -e ${shell(`${ROOT}/lib/libatomic.so.1`)} ]; then curl --fail --location --retry 3 ${shell(LIBATOMIC_URL)} -o ${shell(`${ROOT}/libatomic.deb`)}; echo ${shell(`${LIBATOMIC_SHA256}  ${ROOT}/libatomic.deb`)} | sha256sum --check -; rm -rf ${shell(`${ROOT}/libatomic`)}; dpkg-deb --extract ${shell(`${ROOT}/libatomic.deb`)} ${shell(`${ROOT}/libatomic`)}; cp -a ${shell(`${ROOT}/libatomic/usr/lib/x86_64-linux-gnu`)}/libatomic.so.1* ${shell(`${ROOT}/lib/`)}; fi`,
    `if [ ! -x ${shell(`${ROOT}/bin/mise`)} ]; then curl --fail --location --retry 3 ${shell(url)} -o ${shell(`${ROOT}/mise.tar.gz`)}; echo ${shell(`${SHA256}  ${ROOT}/mise.tar.gz`)} | sha256sum --check -; tar -xzf ${shell(`${ROOT}/mise.tar.gz`)} -C ${shell(`${ROOT}/bin`)} --strip-components=2 mise/bin/mise; chmod +x ${shell(`${ROOT}/bin/mise`)}; fi`,
    ...(config
      ? [
          `printf %s ${shell(config)} > ${shell(configPath)}`,
          `${shell(`${ROOT}/bin/mise`)} install --yes`,
        ]
      : [
          `if [ -f mise.lock ]; then ${shell(`${ROOT}/bin/mise`)} install --yes --locked; else ${shell(`${ROOT}/bin/mise`)} install --yes; fi`,
        ]),
    `${shell(`${ROOT}/bin/mise`)} reshim`,
    `rm -rf ${shell(`${ROOT}/mise.tar.gz`)} ${shell(`${ROOT}/libatomic.deb`)} ${shell(`${ROOT}/libatomic`)}`,
  ].join("\n");
  const variant = config ? `inline-${fingerprint(config)}` : "repository";
  const cachePrefix = `runway-mise-${VERSION}-${variant}-`;
  return defineToolProvider({
    id: "mise",
    cache: {
      paths: [ROOT],
      key: config ? cachePrefix : { prefix: cachePrefix, files: [...CONFIG_FILES] },
      ...(config ? {} : { restoreKeys: [cachePrefix] }),
    },
    setup: install,
    paths: [`${ROOT}/bin`, `${ROOT}/data/shims`],
    env: {
      MISE_CACHE_DIR: `${ROOT}/cache`,
      MISE_DATA_DIR: `${ROOT}/data`,
      MISE_YES: "1",
      LD_LIBRARY_PATH: `${ROOT}/lib`,
      ...(config ? { MISE_CONFIG_FILE: configPath } : {}),
    },
  });
};
