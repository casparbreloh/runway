import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import type { Registry, RunwayConfig, WorkflowDefinition } from "../src/types.ts";

const loadConfig = async (cwd: string): Promise<RunwayConfig> => {
  const mod = (await import(pathToFileURL(resolve(cwd, "runway.config.ts")).href)) as {
    default: RunwayConfig;
  };
  return mod.default;
};

const loadRegistry = async (cwd: string, workflows: ReadonlyArray<string>): Promise<Registry> => {
  const registry = await Promise.all(
    workflows.map(async (path) => {
      const mod = (await import(pathToFileURL(resolve(cwd, path)).href)) as { default?: unknown };
      const def = mod.default;
      if ((def as { __kind?: string } | undefined)?.__kind !== "workflow") {
        throw new Error(`${path}: expected "export default createWorkflow(...)"`);
      }
      return { path, def: def as WorkflowDefinition };
    }),
  );
  const ids = new Set<string>();
  for (const { def, path } of registry) {
    if (ids.has(def.id)) throw new Error(`duplicate workflow id "${def.id}" (${path})`);
    ids.add(def.id);
  }
  return registry;
};

const exec = async (cwd: string, action: "build" | "deploy"): Promise<number> => {
  const config = await loadConfig(cwd);
  const registry = await loadRegistry(cwd, config.workflows);
  const opts = { cwd, outDir: join(cwd, ".runway") };
  if (action === "deploy") await config.backend.deploy(registry, { ...opts, env: process.env });
  else await config.backend.build(registry, opts);
  return registry.length;
};

export const build = (cwd: string): Promise<number> => exec(cwd, "build");
export const deploy = (cwd: string): Promise<number> => exec(cwd, "deploy");
