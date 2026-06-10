import path from "node:path";

import type { Registry } from "@runway/core";

import { bindingOf, classOf } from "./naming.ts";

export const COMPATIBILITY_DATE = "2026-06-06";

export const SANDBOX_VERSION = "0.12.1";
export const SANDBOX_IMAGE = `docker.io/cloudflare/sandbox:${SANDBOX_VERSION}`;
export const SANDBOX_CLASS = "Sandbox";

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

export const generateWorker = (
  registry: Registry,
  opts: { cwd: string; outDir: string; sandbox?: boolean },
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
      (w, i) => `  { binding: ${JSON.stringify(bindingOf(w.def.id))}, trigger: __w${i}.trigger },`,
    )
    .join("\n");
  return `${imports}
import { createRouter, toEntrypoint } from "@runway/cloudflare/worker";
${opts.sandbox ? `export { ${SANDBOX_CLASS} } from "@cloudflare/sandbox";\n` : ""}
${classes}

export default createRouter([
${routes}
]);
`;
};

export const generateWranglerConfig = (
  registry: Registry,
  opts: { name: string; main: string; sandbox?: boolean },
): string => {
  const workflows = registry.map((w) => ({
    name: w.def.id,
    binding: bindingOf(w.def.id),
    class_name: classOf(w.def.id),
  }));
  const crons = cronsOf(registry);
  return `${JSON.stringify(
    {
      name: opts.name,
      main: opts.main,
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: ["nodejs_compat"],
      ...(opts.sandbox
        ? {
            containers: [
              {
                class_name: SANDBOX_CLASS,
                image: SANDBOX_IMAGE,
                instance_type: "basic",
                max_instances: 5,
              },
            ],
            durable_objects: { bindings: [{ class_name: SANDBOX_CLASS, name: SANDBOX_CLASS }] },
            migrations: [{ tag: "v1", new_sqlite_classes: [SANDBOX_CLASS] }],
          }
        : {}),
      workflows,
      ...(crons.length > 0 ? { triggers: { crons } } : {}),
    },
    null,
    2,
  )}
`;
};
