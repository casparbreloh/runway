import { readdir, stat } from "node:fs/promises";
import { join, matchesGlob, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { validateTrigger } from "./trigger.ts";
import { validateSecrets, type WorkflowDefinition } from "./workflow.ts";

export interface RegisteredWorkflow {
  readonly path: string;
  readonly exportName: string;
  readonly def: WorkflowDefinition;
}

export type Registry = ReadonlyArray<RegisteredWorkflow>;

export interface RegistryOptions {
  readonly include?: ReadonlyArray<string>;
  readonly exclude?: ReadonlyArray<string>;
}

export const secretNamesOf = (registry: Registry): ReadonlyArray<string> => [
  ...new Set(registry.flatMap((w) => w.def.secrets)),
];

export const cronsOf = (registry: Registry): ReadonlyArray<string> =>
  registry.flatMap((workflow) =>
    workflow.def.trigger.type === "cron" ? [workflow.def.trigger.expression] : [],
  );

const INCLUDE = [".runway/workflows/**/*.ts"];
const EXCLUDE = ["**/*.test.ts", "**/*.spec.ts", "**/*.d.ts"];

const isWorkflow = (value: unknown): value is WorkflowDefinition =>
  typeof value === "object" &&
  value !== null &&
  (value as { __kind?: unknown }).__kind === "workflow" &&
  Array.isArray((value as { secrets?: unknown }).secrets);

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

export const loadRegistry = async (cwd: string, opts: RegistryOptions = {}): Promise<Registry> => {
  const include = opts.include ?? INCLUDE;
  const exclude = opts.exclude ?? EXCLUDE;
  const paths = await discoverFiles(cwd, include, exclude);
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
