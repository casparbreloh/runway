import { validateCacheDeclaration, type CacheDeclaration, type ExecOptions } from "./step.ts";

export interface ToolProvider {
  readonly id: string;
  readonly cache?: CacheDeclaration;
  readonly setup: string | ExecOptions;
  readonly paths?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type Tools = ToolProvider | readonly ToolProvider[];

const PROVIDER_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const freezeCache = (cache: CacheDeclaration): CacheDeclaration => {
  validateCacheDeclaration(cache);
  const key =
    typeof cache.key === "string"
      ? cache.key
      : Object.freeze({
          ...cache.key,
          files: Object.freeze([cache.key.files[0], ...cache.key.files.slice(1)]) as readonly [
            string,
            ...string[],
          ],
        });
  return Object.freeze({
    key,
    paths: Object.freeze([cache.paths[0], ...cache.paths.slice(1)]) as readonly [
      string,
      ...string[],
    ],
    ...(cache.restoreKeys ? { restoreKeys: Object.freeze([...cache.restoreKeys]) } : {}),
  });
};

const freezeSetup = (setup: string | ExecOptions): string | ExecOptions =>
  typeof setup === "string"
    ? setup
    : Object.freeze({
        ...setup,
        ...(setup.env ? { env: Object.freeze({ ...setup.env }) } : {}),
      });

export const defineToolProvider = (provider: ToolProvider): ToolProvider => {
  if (!PROVIDER_ID.test(provider.id) || provider.id.length > 64) {
    throw new Error(`invalid tool provider id ${JSON.stringify(provider.id)}`);
  }
  if (provider.paths?.some((path) => !path.startsWith("/cache/") || path.includes("\0"))) {
    throw new Error(`tool provider ${provider.id} has an invalid executable path`);
  }
  if (Object.keys(provider.env ?? {}).some((name) => !ENVIRONMENT_NAME.test(name))) {
    throw new Error(`tool provider ${provider.id} has an invalid environment variable`);
  }
  return Object.freeze({
    id: provider.id,
    setup: freezeSetup(provider.setup),
    ...(provider.cache ? { cache: freezeCache(provider.cache) } : {}),
    ...(provider.paths ? { paths: Object.freeze([...provider.paths]) } : {}),
    ...(provider.env ? { env: Object.freeze({ ...provider.env }) } : {}),
  });
};

export const toolProviders = (tools: Tools | undefined): readonly ToolProvider[] => {
  if (!tools) return [];
  const providers = (Array.isArray(tools) ? tools : [tools]).map(defineToolProvider);
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new Error(`duplicate tool provider ${provider.id}`);
    seen.add(provider.id);
  }
  return Object.freeze(providers);
};
