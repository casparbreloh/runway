import { randomBytes } from "node:crypto";
import process from "node:process";

import type { CloudflareApi } from "./cloudflare-api.ts";
import { resolveAuth } from "./deploy-auth.ts";
import { buildDeployment } from "./deploy-build.ts";
import {
  currentSandboxMigrationTag,
  reconcileSandboxContainer,
  runwayMigration,
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
import { createGitHubProvider, type GitHubProvider } from "./github.ts";
import { resolveScriptName } from "./naming.ts";
import { secretNamesOf } from "./registry.ts";
import {
  assertRepositorySourceReachable,
  resolveRepositorySource,
  type RepositorySource,
} from "./repository-source.ts";
import { listScriptSecrets } from "./secret-store.ts";
import type { ProgressEvent, Registry } from "./types.ts";
import {
  GITHUB_APP_ID_BINDING,
  GITHUB_PRIVATE_KEY_BINDING,
  GITHUB_WEBHOOK_SECRET_BINDING,
  SECRET_SNAPSHOT_KEY_BINDING,
} from "./worker-contract.ts";

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
  readonly repository?: RepositorySource;
  readonly reachable?: (repository: RepositorySource) => Promise<void>;
  readonly ready?: (opts: {
    readonly host: string;
    readonly scriptName: string;
    readonly deploymentId: string;
  }) => Promise<void>;
  readonly github?: Pick<GitHubProvider, "resolveRepository" | "createInstallationToken">;
}

const githubRepositoryNameOf = (repository: RepositorySource): string | undefined => {
  let remote: URL;
  try {
    remote = new URL(repository.remote);
  } catch {
    return undefined;
  }
  if (
    remote.protocol !== "https:" ||
    remote.hostname.toLowerCase() !== "github.com" ||
    remote.username ||
    remote.password ||
    remote.search ||
    remote.hash
  ) {
    return undefined;
  }
  const fullName = remote.pathname.replace(/^\//, "").replace(/\.git$/, "");
  if (fullName.split("/").length !== 2) {
    return undefined;
  }
  return fullName;
};

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
  const migration = runwayMigration(migrationTag);
  const missingSecrets = registry.flatMap((w) =>
    w.def.secrets
      .filter((name) => !env[name] && !remoteSecrets.has(name))
      .map((name) => `${w.def.id}.${name}`),
  );
  if (missingSecrets.length > 0) {
    throw new Error(`missing secret(s): ${missingSecrets.join(", ")}`);
  }

  validateBindings(secrets);
  let repository = adapters.repository ?? (await resolveRepositorySource(opts.cwd));
  const hasGitHubTrigger = registry.some(({ def }) => def.trigger.type === "github");
  const appId = env[GITHUB_APP_ID_BINDING];
  const privateKey = env[GITHUB_PRIVATE_KEY_BINDING];
  const githubRepositoryName = githubRepositoryNameOf(repository);
  const appConfigRequested = appId !== undefined || privateKey !== undefined;
  const needsAppConfig =
    hasGitHubTrigger ||
    repository.authentication.type === "github" ||
    (githubRepositoryName !== undefined && appConfigRequested);
  if (needsAppConfig) {
    const missing = [
      ...(appId ? [] : [GITHUB_APP_ID_BINDING]),
      ...(privateKey ? [] : [GITHUB_PRIVATE_KEY_BINDING]),
    ];
    if (missing.length > 0) {
      throw new Error(`missing GitHub App deploy config: ${missing.join(", ")}`);
    }
    if (!/^[1-9][0-9]*$/.test(appId!) || privateKey!.trim().length === 0) {
      throw new Error("invalid GitHub App deploy config");
    }
  }
  if (
    hasGitHubTrigger &&
    !env[GITHUB_WEBHOOK_SECRET_BINDING] &&
    !remoteSecrets.has(GITHUB_WEBHOOK_SECRET_BINDING)
  ) {
    throw new Error(`missing GitHub App secret: ${GITHUB_WEBHOOK_SECRET_BINDING}`);
  }
  const githubProvider = needsAppConfig
    ? (adapters.github ?? createGitHubProvider({ appId: appId!, privateKey: privateKey! }))
    : undefined;
  if (githubProvider && repository.authentication.type === "public") {
    if (!githubRepositoryName) {
      throw new Error("GitHub workflows require a github.com repository remote");
    }
    const resolved = await githubProvider.resolveRepository(githubRepositoryName);
    repository = {
      remote: `https://github.com/${resolved.repository.fullName}`,
      commit: repository.commit,
      authentication: { type: "github", ...resolved },
    };
  }
  if (hasGitHubTrigger && repository.authentication.type !== "github") {
    throw new Error("GitHub workflows require an authenticated github.com repository");
  }
  if (adapters.reachable) {
    await adapters.reachable(repository);
  } else {
    await assertRepositorySourceReachable(
      repository,
      githubProvider
        ? {
            installationToken: async ({ authentication, purpose }) =>
              (
                await githubProvider.createInstallationToken({
                  installationId: authentication.installationId,
                  repository: authentication.repository,
                  purpose,
                })
              ).token,
          }
        : {},
    );
  }
  const secretBindings: Record<string, string> = {};
  for (const name of secrets) {
    const value = env[name];
    if (value) secretBindings[name] = value;
  }
  if (needsAppConfig) {
    secretBindings[GITHUB_APP_ID_BINDING] = appId!;
    secretBindings[GITHUB_PRIVATE_KEY_BINDING] = privateKey!;
  }
  const webhookSecret = env[GITHUB_WEBHOOK_SECRET_BINDING];
  if (hasGitHubTrigger && webhookSecret) {
    secretBindings[GITHUB_WEBHOOK_SECRET_BINDING] = webhookSecret;
  }
  const snapshotKeyAvailable = remoteSecrets.has(SECRET_SNAPSHOT_KEY_BINDING);
  const deployment = await buildDeployment(registry, {
    ...opts,
    scriptName,
    repository,
    snapshotKeyAvailable,
    ...(hasGitHubTrigger && repository.authentication.type === "github"
      ? {
          github: {
            repository: repository.authentication.repository,
            installationId: repository.authentication.installationId,
          },
        }
      : {}),
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
    ...(migration ? { migration } : {}),
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
