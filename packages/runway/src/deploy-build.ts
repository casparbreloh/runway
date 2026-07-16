import { createHash, randomUUID } from "node:crypto";
import { builtinModules } from "node:module";
import path from "node:path";

import { build as esbuild } from "esbuild";
import type { Plugin } from "esbuild";

import { generateDynamicWorker, generateHost } from "./codegen.ts";
import type { RepositorySource } from "./repository-source.ts";
import type { GitHubRepository, ProgressEvent, RegisteredWorkflow, Registry } from "./types.ts";
import { SECRET_SNAPSHOT_KEY_BINDING, secretSnapshotBackupBinding } from "./worker-contract.ts";
import { encodeWorkflowArtifact } from "./workflow-artifact.ts";

interface BuildContext {
  readonly cwd: string;
  readonly scriptName: string;
  readonly repository: RepositorySource;
  readonly snapshotKeyAvailable: boolean;
  readonly github?: { readonly repository: GitHubRepository; readonly installationId: number };
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
    build.onResolve({ filter: /^runway:host-runtime$/ }, () => ({
      path: path.resolve(import.meta.dirname, "host-runtime.ts"),
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

const hashOf = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

const buildDynamicWorker = async (
  workflow: RegisteredWorkflow,
  opts: BuildContext,
): Promise<Uint8Array> => {
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
  return outputOf(result.outputFiles).contents;
};

export interface BuiltWorkflowArtifact {
  readonly workflowId: string;
  readonly artifactVersion: string;
  readonly contents: Uint8Array;
}

export interface PreparedDeployment {
  readonly host: Uint8Array;
  readonly artifacts: ReadonlyArray<BuiltWorkflowArtifact>;
  readonly deploymentId: string;
  readonly secretSnapshotKey: string;
}

export const buildDeployment = async (
  registry: Registry,
  opts: BuildContext,
): Promise<PreparedDeployment> => {
  opts.onProgress?.({ step: "build", status: "start" });
  const deploymentId = randomUUID();
  const secretSnapshotKey = opts.snapshotKeyAvailable
    ? SECRET_SNAPSHOT_KEY_BINDING
    : secretSnapshotBackupBinding(deploymentId);
  const artifacts = await Promise.all(
    registry.map(async (w) => {
      const source = new TextDecoder().decode(await buildDynamicWorker(w, opts));
      const contents = encodeWorkflowArtifact({
        scriptName: opts.scriptName,
        workflowId: w.def.id,
        secrets: w.def.secrets,
        repository: opts.repository,
        source,
      });
      const artifactVersion = hashOf(contents);
      return { workflowId: w.def.id, artifactVersion, contents };
    }),
  );
  const workflowArtifacts = Object.fromEntries(
    artifacts.map((workflow) => [workflow.workflowId, workflow.artifactVersion]),
  );
  const entry = path.join(opts.cwd, "worker.gen.ts");
  const host = generateHost(registry, {
    scriptName: opts.scriptName,
    workflowArtifacts,
    deploymentId,
    secretSnapshotKey,
    ...(opts.github ? { github: opts.github } : {}),
  });
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
            contents: host,
            loader: "ts",
            resolveDir: opts.cwd,
          }));
        },
      },
    ],
  });
  const contents = outputOf(result.outputFiles).contents;
  opts.onProgress?.({ step: "build", status: "done" });
  return {
    host: contents,
    artifacts,
    deploymentId,
    secretSnapshotKey,
  };
};
