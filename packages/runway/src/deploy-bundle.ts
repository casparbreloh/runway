import { createHash, randomUUID } from "node:crypto";
import { builtinModules } from "node:module";
import path from "node:path";

import { build as esbuild } from "esbuild";
import type { Plugin } from "esbuild";

import { generateDynamicWorker, generateWorker } from "./codegen.ts";
import type { ProgressEvent, RegisteredWorkflow, Registry } from "./types.ts";

interface BundleContext {
  readonly cwd: string;
  readonly onProgress?: (event: ProgressEvent) => void;
}

const esbuildBase = {
  bundle: true,
  format: "esm" as const,
  platform: "browser" as const,
  external: ["cloudflare:*", "node:*", ...builtinModules],
  write: false,
};

const runtimeDependencyResolver: Plugin = {
  name: "runway-runtime-dependencies",
  setup(build) {
    build.onResolve({ filter: /^@cloudflare\/dynamic-workflows$/ }, () => ({
      path: path.resolve(
        import.meta.dirname,
        "../node_modules/@cloudflare/dynamic-workflows/dist/index.js",
      ),
    }));
    build.onResolve({ filter: /^@cloudflare\/sandbox$/ }, () => ({
      path: path.resolve(import.meta.dirname, "../node_modules/@cloudflare/sandbox/dist/index.js"),
    }));
  },
};

const outputOf = (
  outputFiles: ReadonlyArray<{ contents: Uint8Array; text: string }> | undefined,
) => {
  const output = outputFiles?.[0];
  if (!output) throw new Error("esbuild returned no output");
  return output;
};

const hashOf = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const buildDynamicWorker = async (
  workflow: RegisteredWorkflow,
  opts: BundleContext,
): Promise<string> => {
  const entry = path.join(opts.cwd, `workflow-${workflow.def.id}.gen.ts`);
  const source = generateDynamicWorker(workflow, { cwd: opts.cwd });
  const result = await esbuild({
    ...esbuildBase,
    entryPoints: [`runway:workflow:${workflow.def.id}`],
    plugins: [
      runtimeDependencyResolver,
      {
        name: "runway-dynamic-workflow",
        setup(build) {
          build.onResolve({ filter: /^runway:workflow:/ }, () => ({
            path: entry,
          }));
          build.onLoad({ filter: /^.*\/workflow-.*\.gen\.ts$/ }, () => ({
            contents: source,
            loader: "ts",
            resolveDir: opts.cwd,
          }));
        },
      },
    ],
  });
  return outputOf(result.outputFiles).text;
};

export const buildWorkerBundle = async (
  registry: Registry,
  opts: BundleContext,
): Promise<Uint8Array> => {
  opts.onProgress?.({ step: "build", status: "start" });
  const deployId = randomUUID();
  const dynamicWorkers = await Promise.all(
    registry.map(async (w) => {
      const code = await buildDynamicWorker(w, opts);
      const loaderId = `${w.def.id}-${hashOf(code)}-${deployId}`;
      return { workflowId: w.def.id, loaderId, code };
    }),
  );
  const modules = Object.fromEntries(dynamicWorkers.map((w) => [w.loaderId, w.code]));
  const workflowLoaders = Object.fromEntries(dynamicWorkers.map((w) => [w.workflowId, w.loaderId]));
  const entry = path.join(opts.cwd, "worker.gen.ts");
  const worker = generateWorker(registry, { cwd: opts.cwd, modules, workflowLoaders });
  const result = await esbuild({
    ...esbuildBase,
    entryPoints: ["runway:worker"],
    plugins: [
      runtimeDependencyResolver,
      {
        name: "runway-worker",
        setup(build) {
          build.onResolve({ filter: /^runway:worker$/ }, () => ({
            path: entry,
          }));
          build.onLoad({ filter: /^.*\/worker\.gen\.ts$/ }, () => ({
            contents: worker,
            loader: "ts",
            resolveDir: opts.cwd,
          }));
        },
      },
    ],
  });
  const contents = outputOf(result.outputFiles).contents;
  opts.onProgress?.({ step: "build", status: "done" });
  return contents;
};
