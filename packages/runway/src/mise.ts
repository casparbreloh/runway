import { shell } from "./internal/tool.ts";
import { defineToolProvider, type ToolProvider } from "./tools.ts";

const ROOT = "/cache/runway/tools/mise";
const BINARY = "/usr/local/bin/mise";
export type MiseTools = Readonly<Record<string, string>>;

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
  const install = [
    `mkdir -p ${shell(`${ROOT}/data`)} ${shell(`${ROOT}/cache`)} ${shell(`${ROOT}/state`)}`,
    ...(config
      ? [`printf %s ${shell(config)} > ${shell(configPath)}`, `${shell(BINARY)} install --yes`]
      : [
          `if [ -f mise.lock ]; then ${shell(BINARY)} install --yes --locked; else ${shell(BINARY)} install --yes; fi`,
        ]),
    `${shell(BINARY)} reshim`,
  ].join("\n");
  return defineToolProvider({
    id: "mise",
    setup: install,
    paths: [`${ROOT}/data/shims`],
    env: {
      MISE_CACHE_DIR: `${ROOT}/cache`,
      MISE_DATA_DIR: `${ROOT}/data`,
      MISE_STATE_DIR: `${ROOT}/state`,
      MISE_YES: "1",
      ...(config ? { MISE_CONFIG_FILE: configPath } : {}),
    },
  });
};
