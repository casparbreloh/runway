import path from "node:path";

import type { Registry } from "@runway/core";

import { bindingOf, classOf } from "./naming.ts";

export const COMPATIBILITY_DATE = "2026-06-06";

export const cronsOf = (registry: Registry): ReadonlyArray<string> =>
  registry.flatMap((w) => (w.def.trigger.type === "cron" ? [w.def.trigger.cron] : []));

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep);

const relImport = (outDir: string, module: string): string => {
  const rel = path.posix.relative(toPosix(outDir), toPosix(module));
  return rel.startsWith(".") ? rel : `./${rel}`;
};

const validateRegistry = (registry: Registry): void => {
  const paths = new Map<string, string>();
  const classes = new Map<string, string>();
  for (const w of registry) {
    const className = classOf(w.def.id);
    const classOwner = classes.get(className);
    if (classOwner) {
      throw new Error(`${w.path}: generated class name ${className} already used by ${classOwner}`);
    }
    classes.set(className, w.path);
    if (w.def.trigger.type === "webhook") {
      const owner = paths.get(w.def.trigger.path);
      if (owner) {
        throw new Error(
          `${w.path}: duplicate webhook trigger path ${JSON.stringify(w.def.trigger.path)} already used by ${owner}`,
        );
      }
      paths.set(w.def.trigger.path, w.path);
    }
  }
};

const workflowRef = (index: number, exportName: string): string =>
  exportName === "default" ? `__m${index}.default` : `__m${index}[${JSON.stringify(exportName)}]`;

export const generateWorker = (
  registry: Registry,
  opts: { cwd: string; outDir: string },
): string => {
  validateRegistry(registry);
  const imports = registry
    .map(
      (w, i) =>
        `import * as __m${i} from ${JSON.stringify(relImport(opts.outDir, path.resolve(opts.cwd, w.path)))};`,
    )
    .join("\n");
  const classes = registry
    .map(
      (w, i) =>
        `export class ${classOf(w.def.id)} extends toEntrypoint(${workflowRef(i, w.exportName)}) {}`,
    )
    .join("\n");
  const routes = registry
    .map(
      (w) =>
        `  { binding: ${JSON.stringify(bindingOf(w.def.id))}, trigger: ${JSON.stringify(w.def.trigger)} },`,
    )
    .join("\n");
  return `${imports}
import { createRouter, toEntrypoint } from "@runway/cloudflare/worker";

${classes}

export default createRouter([
${routes}
]);
`;
};
