import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build as esbuild } from "esbuild";
import type { Plugin } from "esbuild";

import type { GitHubRepository } from "../../trigger.ts";
import {
  encodeReleaseRegistry,
  type ReleaseRegistry,
  type ReleaseRoute,
} from "../release/registry.ts";
import { encodeWorkflowArtifact } from "../runtime/artifact.ts";
import {
  DATA_BUCKET,
  DYNAMIC_WORKFLOW_CLASS,
  RUNWAY_WORKFLOW_CLASS,
  SECRET_SNAPSHOT_KEY_BINDING,
  secretSnapshotBackupBinding,
} from "../runtime/contract.ts";
import { SANDBOX_IMAGE_DIGEST } from "../sandbox/config.ts";
import type { RepositorySource } from "../source/repository.ts";
import type { ProgressEvent } from "./publish.ts";
import {
  secretNamesOf,
  validateRegistry,
  type RegisteredWorkflow,
  type Registry,
} from "./registry.ts";

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

const hostSource = (opts: {
  accountId: string;
  deploymentName: string;
  deploymentId: string;
  secretSnapshotKey: string;
  authorSecretNames: readonly string[];
  repository: RepositorySource;
  defaultBranch?: string;
  github?: { readonly repository: GitHubRepository; readonly installationId: number };
}): string => {
  const config = JSON.stringify({
    accountId: opts.accountId,
    cacheBucket: DATA_BUCKET,
    imageDigest: SANDBOX_IMAGE_DIGEST,
    deploymentName: opts.deploymentName,
    deploymentId: opts.deploymentId,
    secretSnapshotKey: opts.secretSnapshotKey,
    authorSecretNames: [...opts.authorSecretNames].sort(),
    repository: {
      remote: opts.repository.remote,
      authentication: opts.repository.authentication,
    },
    ...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {}),
    ...(opts.github ? { github: opts.github } : {}),
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

export interface BuildContext {
  readonly accountId: string;
  readonly cwd: string;
  readonly deploymentName: string;
  readonly defaultBranch?: string;
  readonly repository: RepositorySource;
  readonly snapshotKeyAvailable: boolean;
  readonly github?: { readonly repository: GitHubRepository; readonly installationId: number };
  readonly deploymentId?: string;
  readonly secretSnapshotKey?: string;
  readonly authorSecretNames?: readonly string[];
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
    build.onResolve({ filter: /^runway$/ }, () => ({
      path: path.resolve(import.meta.dirname, "../../index.ts"),
    }));
    build.onResolve({ filter: /^runway\/runtime$/ }, () => ({
      path: path.resolve(import.meta.dirname, "../../runtime.ts"),
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
          build.onResolve({ filter: /^runway:workflow:/ }, () => ({ path: entry }));
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

export interface PreparedHost {
  readonly host: Uint8Array;
  readonly deploymentId: string;
  readonly secretSnapshotKey: string;
}

export interface PreparedRelease {
  readonly artifacts: readonly BuiltWorkflowArtifact[];
  readonly registry: ReleaseRegistry;
  readonly registryContents: Uint8Array;
  readonly registryVersion: string;
}

export interface PreparedDeployment extends PreparedHost, PreparedRelease {}

const routeOf = (
  workflow: RegisteredWorkflow,
  artifactVersion: string,
): ReleaseRoute | undefined => {
  const trigger = workflow.def.trigger;
  if (!trigger) return undefined;
  if (trigger.type === "webhook") {
    return { id: workflow.def.id, artifactVersion, type: "webhook", path: trigger.path };
  }
  if (trigger.type === "cron") {
    return { id: workflow.def.id, artifactVersion, type: "cron", expression: trigger.expression };
  }
  if (trigger.type === "github") {
    return {
      id: workflow.def.id,
      artifactVersion,
      type: "github",
      checkName: trigger.checkName,
      events: trigger.events,
    };
  }
  const unsupported: never = trigger;
  throw new Error(`unsupported workflow trigger: ${String(unsupported)}`);
};

export const buildRelease = async (
  registry: Registry,
  opts: BuildContext,
): Promise<PreparedRelease> => {
  validateRegistry(registry);
  opts.onProgress?.({ step: "build", status: "start" });
  const artifacts = await Promise.all(
    registry.map(async (workflow) => {
      const source = new TextDecoder().decode(await buildDynamicWorker(workflow, opts));
      const contents = encodeWorkflowArtifact({
        deploymentName: opts.deploymentName,
        workflowId: workflow.def.id,
        secrets: workflow.def.secrets,
        repository: opts.repository,
        source,
      });
      return {
        workflowId: workflow.def.id,
        artifactVersion: hashOf(contents),
        contents,
      };
    }),
  );
  const versions = new Map(
    artifacts.map((artifact) => [artifact.workflowId, artifact.artifactVersion]),
  );
  const routes = registry
    .map((workflow) => routeOf(workflow, versions.get(workflow.def.id)!))
    .filter((route): route is ReleaseRoute => route !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id));
  const published: ReleaseRegistry = {
    schema: 1,
    deploymentName: opts.deploymentName,
    ...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {}),
    repository: opts.repository,
    ...(opts.github ? { github: opts.github } : {}),
    secretNames: [...secretNamesOf(registry)].sort(),
    routes,
  };
  const registryContents = encodeReleaseRegistry(published);
  opts.onProgress?.({ step: "build", status: "done" });
  return {
    artifacts,
    registry: published,
    registryContents,
    registryVersion: hashOf(registryContents),
  };
};

const buildHostContents = async (
  opts: BuildContext,
  deploymentId: string,
  secretSnapshotKey: string,
): Promise<Uint8Array> => {
  const entry = path.join(opts.cwd, "worker.gen.ts");
  const result = await esbuild({
    ...esbuildBase,
    entryPoints: ["runway:worker"],
    plugins: [
      runtimeDependencyResolver,
      {
        name: "runway-worker",
        setup(build) {
          build.onResolve({ filter: /^runway:worker$/ }, () => ({ path: entry }));
          build.onLoad({ filter: /^.*\/worker\.gen\.ts$/ }, () => ({
            contents: hostSource({
              accountId: opts.accountId,
              deploymentName: opts.deploymentName,
              deploymentId,
              secretSnapshotKey,
              authorSecretNames: opts.authorSecretNames ?? [],
              repository: opts.repository,
              ...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {}),
              ...(opts.github ? { github: opts.github } : {}),
            }),
            loader: "ts",
            resolveDir: opts.cwd,
          }));
        },
      },
    ],
  });
  return outputOf(result.outputFiles).contents;
};

export const buildHost = async (opts: BuildContext): Promise<PreparedHost> => {
  const hostSnapshotKey = opts.secretSnapshotKey ?? SECRET_SNAPSHOT_KEY_BINDING;
  const deploymentId =
    opts.deploymentId ??
    hashOf(await buildHostContents(opts, "runway-structural-host", hostSnapshotKey));
  const secretSnapshotKey =
    opts.secretSnapshotKey ??
    (opts.snapshotKeyAvailable
      ? SECRET_SNAPSHOT_KEY_BINDING
      : secretSnapshotBackupBinding(deploymentId));
  const host = await buildHostContents(opts, deploymentId, hostSnapshotKey);
  return { host, deploymentId, secretSnapshotKey };
};

export const buildDeployment = async (
  registry: Registry,
  opts: BuildContext,
): Promise<PreparedDeployment> => {
  const host = await buildHost({
    ...opts,
    authorSecretNames: [...secretNamesOf(registry)].sort(),
  });
  const release = await buildRelease(registry, opts);
  return { ...host, ...release };
};
