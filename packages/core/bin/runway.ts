#!/usr/bin/env node
import { readdir, stat } from "node:fs/promises";
import { join, matchesGlob, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { defineCommand, runMain } from "citty";

import pkg from "../package.json" with { type: "json" };
import { validateTrigger } from "../src/trigger.ts";
import type { ProgressEvent, Registry, RunwayConfig, WorkflowDefinition } from "../src/types.ts";
import { validateSecrets } from "../src/workflow.ts";

const LABELS: Record<ProgressEvent["step"], Record<ProgressEvent["status"], string>> = {
  load: { start: "Loading", done: "Loaded" },
  build: { start: "Building", done: "Built" },
  deploy: { start: "Deploying", done: "Deployed" },
};

const spinner = () => {
  const frames = [".  ", ".. ", "..."];
  let timer: NodeJS.Timeout | undefined;
  let i = 0;
  const clear = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    process.stderr.write("\r\x1b[K");
  };
  return {
    event(event: ProgressEvent) {
      const label = LABELS[event.step][event.status];
      if (!process.stderr.isTTY) {
        console.error(event.status === "start" ? `${label}...` : `${label}.`);
        return;
      }
      clear();
      if (event.status === "start") {
        process.stderr.write(`${label}${frames[0]}\r`);
        timer = setInterval(() => {
          i = (i + 1) % frames.length;
          process.stderr.write(`${label}${frames[i]}\r`);
        }, 80);
      } else {
        console.error(`${label}.`);
      }
    },
    fail(message: string) {
      clear();
      console.error("runway: deploy failed");
      console.error(`  ${message}`);
    },
  };
};

const isWorkflow = (value: unknown): value is WorkflowDefinition =>
  typeof value === "object" &&
  value !== null &&
  (value as { __kind?: unknown }).__kind === "workflow" &&
  Array.isArray((value as { secrets?: unknown }).secrets);

const DEFAULT_INCLUDE = [".runway/workflows/**/*.ts"];
const DEFAULT_EXCLUDE = ["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts"];

const toPosix = (path: string): string => path.split(sep).join("/");

const hasGlob = (part: string): boolean => /[*?]/.test(part);

const staticBaseOf = (glob: string): string => {
  const parts = toPosix(glob).split("/");
  const index = parts.findIndex((part) => part === "**" || hasGlob(part));
  const base = parts.slice(0, index === -1 ? parts.length : index);
  return base.length === 0 ? "." : base.join("/");
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const walkFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
};

const matches = (file: string, pattern: string): boolean =>
  matchesGlob(file, pattern) || matchesGlob(file.replaceAll("/.", "/").replace(/^\./, ""), pattern);

const loadConfig = async (cwd: string): Promise<RunwayConfig> => {
  const path = (await exists(resolve(cwd, "runway.config.ts")))
    ? resolve(cwd, "runway.config.ts")
    : resolve(cwd, ".runway/runway.config.ts");
  const mod = (await import(pathToFileURL(path).href)) as {
    default: RunwayConfig;
  };
  return mod.default;
};

const discoverFiles = async (
  cwd: string,
  include: ReadonlyArray<string>,
  exclude: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  const candidates = new Set<string>();
  for (const pattern of include) {
    const base = resolve(cwd, staticBaseOf(pattern));
    if (!hasGlob(pattern) && (await exists(base))) {
      candidates.add(toPosix(base).slice(toPosix(cwd).length + 1));
      continue;
    }
    for (const file of await walkFiles(base)) {
      candidates.add(toPosix(file).slice(toPosix(cwd).length + 1));
    }
  }
  return [...candidates]
    .filter((file) => include.some((pattern) => matches(file, pattern)))
    .filter((file) => !exclude.some((pattern) => matches(file, pattern)))
    .sort();
};

const loadRegistry = async (cwd: string, config: RunwayConfig): Promise<Registry> => {
  const paths = await discoverFiles(
    cwd,
    config.include ?? DEFAULT_INCLUDE,
    config.exclude ?? DEFAULT_EXCLUDE,
  );
  const workflows = new Map<WorkflowDefinition, { path: string; exportName: string }>();
  for (const path of paths) {
    const mod = (await import(pathToFileURL(resolve(cwd, path)).href)) as Record<string, unknown>;
    for (const [exportName, value] of Object.entries(mod)) {
      if (!isWorkflow(value)) continue;
      const existing = workflows.get(value);
      if (existing) {
        if (path < existing.path || (path === existing.path && exportName < existing.exportName)) {
          workflows.set(value, { path, exportName });
        }
        continue;
      }
      validateTrigger(value.trigger);
      validateSecrets(value.secrets);
      workflows.set(value, { path, exportName });
    }
  }
  const registry = [...workflows].map(([def, item]) => ({ ...item, def }));
  if (registry.length === 0) {
    throw new Error(`no workflows found; checked ${paths.length} file(s)`);
  }
  const ids = new Set<string>();
  for (const { def, path } of registry) {
    if (ids.has(def.id)) throw new Error(`duplicate workflow id "${def.id}" (${path})`);
    ids.add(def.id);
  }
  return registry;
};

const deploy = defineCommand({
  meta: { name: "deploy", description: "Build and deploy all registered workflows" },
  async run() {
    const out = spinner();
    try {
      const cwd = process.cwd();
      out.event({ step: "load", status: "start" });
      const config = await loadConfig(cwd);
      const registry = await loadRegistry(cwd, config);
      out.event({ step: "load", status: "done" });
      const result = await config.backend.deploy(registry, {
        cwd,
        env: process.env,
        onProgress: (event) => out.event(event),
      });
      console.log(`Deployed ${registry.length} workflow(s) as ${result.script}`);
      for (const { id, url } of result.urls) {
        console.log(`  ${id}: POST ${url}`);
      }
    } catch (err) {
      out.fail(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  },
});

await runMain(
  defineCommand({
    meta: { name: "runway", version: pkg.version, description: "Deploy code-first workflows" },
    subCommands: { deploy },
  }),
);
