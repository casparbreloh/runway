import path from "node:path";

import type { Registry } from "@runway/core";

import { bindingOf, classOf } from "./ids.ts";

export { bindingOf, classOf } from "./ids.ts";

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep);

const relImport = (outDir: string, module: string): string => {
  const rel = path.posix.relative(toPosix(outDir), toPosix(module));
  return rel.startsWith(".") ? rel : `./${rel}`;
};

const triggerOf = (trigger: Registry[number]["def"]["trigger"]): string => {
  if (trigger.type === "cron") {
    return `{ type: "cron", cron: ${JSON.stringify(trigger.cron)} }`;
  }
  return `{ type: "webhook", path: ${JSON.stringify(trigger.path)}, auth: ${JSON.stringify(trigger.auth)} }`;
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

export const generateWorker = (
  registry: Registry,
  opts: { cwd: string; outDir: string },
): string => {
  validateRegistry(registry);
  const imports = registry
    .map(
      (w, i) =>
        `import __w${i} from ${JSON.stringify(relImport(opts.outDir, path.resolve(opts.cwd, w.path)))};`,
    )
    .join("\n");
  const classes = registry
    .map((w, i) => `export class ${classOf(w.def.id)} extends toEntrypoint(__w${i}) {}`)
    .join("\n");
  const routes = registry
    .map(
      (w) =>
        `  { id: ${JSON.stringify(w.def.id)}, binding: ${JSON.stringify(bindingOf(w.def.id))}, trigger: ${triggerOf(w.def.trigger)} },`,
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

export const generateWranglerConfig = (
  registry: Registry,
  opts: { name: string; main: string },
): string => {
  const workflows = registry.map((w) => {
    return {
      name: w.def.id,
      binding: bindingOf(w.def.id),
      class_name: classOf(w.def.id),
    };
  });
  const crons = registry
    .map((w) => w.def.trigger)
    .filter((trigger) => trigger.type === "cron")
    .map((trigger) => trigger.cron);
  return `${JSON.stringify(
    {
      name: opts.name,
      main: opts.main,
      compatibility_date: "2026-06-06",
      workflows,
      ...(crons.length > 0 ? { triggers: { crons } } : {}),
    },
    null,
    2,
  )}
`;
};
