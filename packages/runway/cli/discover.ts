import { glob } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import type { WorkflowDef } from "../src/types.ts";

export interface Discovered {
  readonly file: string;
  readonly def: WorkflowDef<unknown>;
}

export const discover = async (cwd: string, dir = "runway"): Promise<Discovered[]> => {
  const files: string[] = [];
  for await (const entry of glob(`${dir}/**/*`, { cwd })) {
    if (/\.[cm]?[jt]s$/.test(entry)) files.push(entry);
  }
  files.sort();
  if (files.length === 0) return [];

  const entrySource = files
    .map((file, i) => `export { default as w${i} } from ${JSON.stringify("./" + file)};`)
    .join("\n");
  const outfile = join(cwd, ".runway", "discover.mjs");
  await build({
    stdin: {
      contents: entrySource,
      resolveDir: cwd,
      loader: "ts",
      sourcefile: "discover-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    external: ["cloudflare:*", "@cloudflare/sandbox"],
    outfile,
    logLevel: "silent",
  });

  const mod = (await import(pathToFileURL(outfile).href)) as Record<string, WorkflowDef<unknown>>;
  return files.map((file, i) => {
    const def = mod[`w${i}`];
    if (!def || !def.trigger || typeof def.run !== "function") {
      throw new Error(`${file}: default export is not a workflow(...)`);
    }
    return { file, def };
  });
};
