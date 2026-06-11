import path from "node:path";

import type { Registry } from "@runway/core";

import { bindingOf, classOf } from "./naming.ts";
import { validateRegistry } from "./validate.ts";

export const COMPATIBILITY_DATE = "2026-06-06";

export const cronsOf = (registry: Registry): ReadonlyArray<string> =>
  registry.flatMap((w) => (w.def.trigger.type === "cron" ? [w.def.trigger.expression] : []));

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep);

const relImport = (cwd: string, module: string): string => {
  const rel = path.posix.relative(toPosix(cwd), toPosix(module));
  return rel.startsWith("./") || rel.startsWith("../") ? rel : `./${rel}`;
};

const workflowRef = (index: number, exportName: string): string =>
  exportName === "default" ? `__m${index}.default` : `__m${index}[${JSON.stringify(exportName)}]`;

export const generateWorker = (registry: Registry, opts: { cwd: string }): string => {
  validateRegistry(registry);
  const imports = registry
    .map(
      (w, i) =>
        `import * as __m${i} from ${JSON.stringify(relImport(opts.cwd, path.resolve(opts.cwd, w.path)))};`,
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
      (w, i) =>
        `  { id: ${JSON.stringify(w.def.id)}, binding: ${JSON.stringify(bindingOf(w.def.id))}, trigger: ${workflowRef(i, w.exportName)}.trigger },`,
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
