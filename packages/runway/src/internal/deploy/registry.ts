import { readdir, stat } from "node:fs/promises";
import { join, matchesGlob, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { secretNameOf } from "../../secret.ts";
import { validateTrigger } from "../../trigger.ts";
import type { WebhookTimestamp, WebhookTrigger } from "../../trigger.ts";
import { validateSecrets, type WorkflowDefinition } from "../../workflow.ts";

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

const timestampEqual = (a?: WebhookTimestamp, b?: WebhookTimestamp): boolean =>
  a?.source === b?.source && a?.field === b?.field && a?.toleranceMs === b?.toleranceMs;

const verificationDiffs = (
  a: WebhookTrigger<unknown>,
  b: WebhookTrigger<unknown>,
): ReadonlyArray<string> => {
  const render = (value: unknown): string => (value === undefined ? "none" : JSON.stringify(value));
  const diffs: string[] = [];
  if (secretNameOf(a.secret) !== secretNameOf(b.secret)) {
    diffs.push(`secret (${render(secretNameOf(a.secret))} vs ${render(secretNameOf(b.secret))})`);
  }
  if (a.signatureHeader !== b.signatureHeader) {
    diffs.push(`signatureHeader (${render(a.signatureHeader)} vs ${render(b.signatureHeader)})`);
  }
  if (a.prefix !== b.prefix) diffs.push(`prefix (${render(a.prefix)} vs ${render(b.prefix)})`);
  if (!timestampEqual(a.timestamp, b.timestamp)) {
    diffs.push(`timestamp (${render(a.timestamp)} vs ${render(b.timestamp)})`);
  }
  return diffs;
};

export const validateRegistry = (registry: Registry): void => {
  const paths = new Map<string, { path: string; trigger: WebhookTrigger<unknown> }>();
  for (const workflow of registry) {
    if (workflow.def.trigger.type !== "webhook") continue;
    const owner = paths.get(workflow.def.trigger.path);
    if (!owner) {
      paths.set(workflow.def.trigger.path, {
        path: workflow.path,
        trigger: workflow.def.trigger,
      });
      continue;
    }
    const diffs = verificationDiffs(workflow.def.trigger, owner.trigger);
    if (diffs.length > 0) {
      throw new Error(
        `${workflow.path}: webhook path ${JSON.stringify(workflow.def.trigger.path)} conflicts with ${owner.path}: ${diffs.join(", ")}`,
      );
    }
  }
};

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
