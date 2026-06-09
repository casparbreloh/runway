import path from "node:path";

import type { Registry } from "@runway/core";

export const bindingOf = (id: string): string => id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

export const classOf = (id: string): string =>
  id
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep);

const relImport = (outDir: string, module: string): string => {
  const rel = path.posix.relative(toPosix(outDir), toPosix(module));
  return rel.startsWith(".") ? rel : `./${rel}`;
};

export const generateWorker = (
  registry: Registry,
  opts: { cwd: string; outDir: string },
): string => {
  const byClass = new Map<string, string>();
  const byBinding = new Map<string, string>();
  for (const { def } of registry) {
    const cls = classOf(def.id);
    const bnd = bindingOf(def.id);
    if (byClass.has(cls)) {
      throw new Error(
        `workflow ids "${byClass.get(cls)}" and "${def.id}" collide on class "${cls}"`,
      );
    }
    if (byBinding.has(bnd)) {
      throw new Error(
        `workflow ids "${byBinding.get(bnd)}" and "${def.id}" collide on binding "${bnd}"`,
      );
    }
    byClass.set(cls, def.id);
    byBinding.set(bnd, def.id);
  }
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
        `  { id: ${JSON.stringify(w.def.id)}, binding: ${JSON.stringify(bindingOf(w.def.id))} },`,
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
