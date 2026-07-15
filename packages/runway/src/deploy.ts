import { randomBytes } from "node:crypto";
import process from "node:process";

import type { CloudflareApi } from "./cloudflare-api.ts";
import { resolveAuth } from "./deploy-auth.ts";
import { buildDeployment } from "./deploy-build.ts";
import {
  currentSandboxMigrationTag,
  needsSandboxMigration,
  reconcileSandboxContainer,
} from "./deploy-container.ts";
import {
  assertDynamicWorkflowOwnership,
  deleteStaleDynamicWorkflows,
  updateCronSchedules,
  updateDynamicWorkflow,
  waitForDeploymentReadiness,
  enableWorkersDev,
} from "./deploy-finalize.ts";
import { uploadWorkflowArtifacts } from "./deploy-storage.ts";
import { uploadWorker, validateBindings } from "./deploy-upload.ts";
import { resolveScriptName } from "./naming.ts";
import { secretNamesOf } from "./registry.ts";
import { listScriptSecrets } from "./secret-store.ts";
import type { ProgressEvent, Registry } from "./types.ts";
import { SECRET_SNAPSHOT_KEY_BINDING } from "./worker-contract.ts";

export type { CloudflareApi } from "./cloudflare-api.ts";
export { resolveAuth } from "./deploy-auth.ts";

interface DeployContext {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly wranglerAuth?: boolean;
}

interface DeployOutput {
  readonly script: string;
  readonly artifactVersions: ReadonlyArray<string>;
  readonly urls: ReadonlyArray<{ readonly id: string; readonly url: string }>;
}

interface DeployAdapters {
  readonly client?: (opts: { apiToken: string }) => CloudflareApi;
  readonly ready?: (opts: {
    readonly host: string;
    readonly scriptName: string;
    readonly deploymentId: string;
  }) => Promise<void>;
}

const waitUntilReady = async (opts: {
  readonly host: string;
  readonly scriptName: string;
  readonly deploymentId: string;
}): Promise<void> =>
  await waitForDeploymentReadiness({
    fetch: globalThis.fetch,
    wait: (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
    ...opts,
  });

export const deployWithAdapters = async (
  registry: Registry,
  opts: DeployContext,
  adapters: DeployAdapters,
): Promise<DeployOutput> => {
  const env = opts.env ?? process.env;
  const secrets = secretNamesOf(registry);
  const scriptName = await resolveScriptName({ cwd: opts.cwd, env });
  const workflowName = scriptName;
  const { accountId, cf } = await resolveAuth(
    { ...opts, ...(adapters.client ? { client: adapters.client } : {}) },
    env,
  );
  await assertDynamicWorkflowOwnership(cf, accountId, workflowName, scriptName);
  const remoteSecrets = await listScriptSecrets(cf, accountId, scriptName);
  const migrationTag = await currentSandboxMigrationTag(cf, accountId, scriptName);
  const missingSecrets = registry.flatMap((w) =>
    w.def.secrets
      .filter((name) => !env[name] && !remoteSecrets.has(name))
      .map((name) => `${w.def.id}.${name}`),
  );
  if (missingSecrets.length > 0) {
    throw new Error(`missing secret(s): ${missingSecrets.join(", ")}`);
  }

  validateBindings(secrets);
  const secretBindings: Record<string, string> = {};
  for (const name of secrets) {
    const value = env[name];
    if (value) secretBindings[name] = value;
  }
  const snapshotKeyAvailable = remoteSecrets.has(SECRET_SNAPSHOT_KEY_BINDING);
  const deployment = await buildDeployment(registry, {
    ...opts,
    scriptName,
    snapshotKeyAvailable,
  });
  if (!snapshotKeyAvailable) {
    const identity = deployment.secretSnapshotKey;
    secretBindings[SECRET_SNAPSHOT_KEY_BINDING] = JSON.stringify({ identity });
    secretBindings[identity] = JSON.stringify({
      identity,
      key: randomBytes(32).toString("base64"),
    });
  }
  opts.onProgress?.({ step: "deploy", status: "start" });
  const artifactBucketName = await uploadWorkflowArtifacts(cf, accountId, deployment);
  await uploadWorker(cf, {
    accountId,
    scriptName,
    workflowName,
    artifactBucketName,
    contents: deployment.host,
    secretBindings,
    needsSandboxMigration: needsSandboxMigration(migrationTag),
  });
  await reconcileSandboxContainer(cf, accountId, scriptName);
  await updateDynamicWorkflow(cf, accountId, workflowName, scriptName);
  await updateCronSchedules(cf, accountId, scriptName, registry);
  await deleteStaleDynamicWorkflows(cf, accountId, workflowName, scriptName);
  const workersDev = await enableWorkersDev(cf, accountId, scriptName, registry);
  await (adapters.ready ?? waitUntilReady)({
    host: workersDev.host,
    scriptName,
    deploymentId: deployment.deploymentId,
  });

  opts.onProgress?.({ step: "deploy", status: "done" });
  return {
    script: scriptName,
    artifactVersions: deployment.artifacts.map(({ artifactVersion }) => artifactVersion),
    urls: workersDev.urls,
  };
};

export const deploy = async (registry: Registry, opts: DeployContext): Promise<DeployOutput> =>
  await deployWithAdapters(registry, opts, {});
