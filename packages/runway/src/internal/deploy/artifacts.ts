import { createHash, randomUUID } from "node:crypto";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";
import type { Plugin } from "esbuild";

import type { ProgressEvent } from "../../deploy.ts";
import type { GitHubRepository } from "../../trigger.ts";
import { encodeWorkflowArtifact } from "../runtime/artifact.ts";
import {
  DYNAMIC_WORKFLOW_CLASS,
  RUNWAY_WORKFLOW_CLASS,
  SECRET_SNAPSHOT_KEY_BINDING,
  secretSnapshotBackupBinding,
} from "../runtime/contract.ts";
import { SANDBOX_IMAGE_DIGEST } from "../sandbox/config.ts";
import type { RepositorySource } from "../source/repository.ts";
import { validateRegistry, type RegisteredWorkflow, type Registry } from "./registry.ts";

const toPosix = (value: string): string => value.split(path.sep).join(path.posix.sep);

const relImport = (cwd: string, module: string): string => {
  const relative = path.posix.relative(toPosix(cwd), toPosix(module));
  return relative.startsWith("./") || relative.startsWith("../") ? relative : `./${relative}`;
};

const workflowRef = (exportName: string): string =>
  exportName === "default"
    ? "workflowModule.default"
    : `workflowModule[${JSON.stringify(exportName)}]`;

const dynamicWorkerSource = (workflow: RegisteredWorkflow, cwd: string): string => {
  const ref = workflowRef(workflow.exportName);
  return `import * as workflowModule from ${JSON.stringify(relImport(cwd, path.resolve(cwd, workflow.path)))};
import { createWorkflowWorker, toEntrypoint } from "runway/runtime";

const workflow = ${ref};

export class ${RUNWAY_WORKFLOW_CLASS} extends toEntrypoint(workflow) {}

export default createWorkflowWorker(workflow);
`;
};

const hostSource = (
  registry: Registry,
  opts: {
    accountId: string;
    scriptName: string;
    workflowArtifacts: Readonly<Record<string, string>>;
    deploymentId: string;
    secretSnapshotKey: string;
    github?: { readonly repository: GitHubRepository; readonly installationId: number };
  },
): string => {
  validateRegistry(registry);
  const routes = registry.map((workflow) => {
    const artifactVersion = opts.workflowArtifacts[workflow.def.id]!;
    if (workflow.def.trigger.type === "webhook") {
      return {
        id: workflow.def.id,
        artifactVersion,
        type: "webhook",
        path: workflow.def.trigger.path,
      };
    }
    if (workflow.def.trigger.type === "github") {
      return {
        id: workflow.def.id,
        artifactVersion,
        type: "github",
        checkName: workflow.def.trigger.checkName,
        events: workflow.def.trigger.events,
      };
    }
    return {
      id: workflow.def.id,
      artifactVersion,
      type: "cron",
      expression: workflow.def.trigger.expression,
    };
  });
  const config = JSON.stringify({
    accountId: opts.accountId,
    cacheBucket: `runway-${opts.accountId}`,
    imageDigest: SANDBOX_IMAGE_DIGEST,
    scriptName: opts.scriptName,
    deploymentId: opts.deploymentId,
    secretSnapshotKey: opts.secretSnapshotKey,
    github: opts.github,
    routes,
  });
  return `import { DynamicWorkflowBinding } from "@cloudflare/dynamic-workflows";
import { Sandbox } from "@cloudflare/sandbox";
import {
  RunwayGitHubCoordinator,
  RunwaySandboxBinding,
  createDynamicWorkflow,
  createHost,
} from "runway:host-runtime";

export { DynamicWorkflowBinding, RunwayGitHubCoordinator, RunwaySandboxBinding, Sandbox };

const config = ${config};

export const ${DYNAMIC_WORKFLOW_CLASS} = createDynamicWorkflow(config);

export default createHost(config);
`;
};

interface BuildContext {
  readonly accountId: string;
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
      path: fileURLToPath(import.meta.resolve("@cloudflare/dynamic-workflows")),
    }));
    build.onResolve({ filter: /^@cloudflare\/sandbox$/ }, () => ({
      path: fileURLToPath(import.meta.resolve("@cloudflare/sandbox")),
    }));
    build.onResolve({ filter: /^runway:host-runtime$/ }, () => ({
      path: path.resolve(import.meta.dirname, "../runtime/host.ts"),
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
  const source = dynamicWorkerSource(workflow, opts.cwd);
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
  const host = hostSource(registry, {
    accountId: opts.accountId,
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
