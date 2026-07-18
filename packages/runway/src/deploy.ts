import { createHash, randomBytes } from "node:crypto";
import process from "node:process";

import type { CloudflareApi } from "./internal/cloudflare.ts";
import { buildDeployment } from "./internal/deploy/artifacts.ts";
import { resolveAuth } from "./internal/deploy/auth.ts";
import { deploymentNameOf } from "./internal/deploy/name.ts";
import { cronsOf, secretNamesOf, type Registry } from "./internal/deploy/registry.ts";
import { waitForRollout } from "./internal/deploy/rollout.ts";
import { createGitHubProvider, type GitHubProvider } from "./internal/github/provider.ts";
import {
  GITHUB_APP_ID_BINDING,
  GITHUB_PRIVATE_KEY_BINDING,
  GITHUB_WEBHOOK_SECRET_BINDING,
  DATA_BUCKET,
  SECRET_SNAPSHOT_KEY_BINDING,
  STATE_BUCKET,
} from "./internal/runtime/contract.ts";
import { listScriptSecrets } from "./internal/secret/store.ts";
import {
  assertRepositorySourceReachable,
  resolveRepositorySource,
  type RepositorySource,
} from "./internal/source/repository.ts";
import {
  CloudflareStackControl,
  cloudflareStackManifest,
  validateBindings,
} from "./internal/stack/cloudflare.ts";
import { Stack, type StackControl, type StackManifest } from "./internal/stack/stack.ts";

export type { CloudflareApi } from "./internal/cloudflare.ts";
export { resolveAuth } from "./internal/deploy/auth.ts";

export interface ProgressEvent {
  readonly step: "load" | "build" | "deploy";
  readonly status: "start" | "done";
}

interface DeployContext {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly wranglerAuth?: boolean;
}

interface DeployOutput {
  readonly name: string;
  readonly artifactVersions: ReadonlyArray<string>;
  readonly urls: ReadonlyArray<{ readonly id: string; readonly url: string }>;
  readonly remove: () => Promise<void>;
}

interface DeployAdapters {
  readonly deploymentName?: string;
  readonly client?: (opts: { apiToken: string }) => CloudflareApi;
  readonly repository?: RepositorySource;
  readonly reachable?: (repository: RepositorySource) => Promise<void>;
  readonly ready?: (opts: {
    readonly host: string;
    readonly scriptName: string;
    readonly deploymentId: string;
  }) => Promise<void>;
  readonly github?: Pick<GitHubProvider, "resolveRepository" | "createInstallationToken">;
  readonly stack?: (
    manifest: StackManifest,
  ) => StackControl & { urls(): readonly { readonly id: string; readonly url: string }[] };
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
  await waitForRollout({
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
  let repository = adapters.repository ?? (await resolveRepositorySource(opts.cwd));
  const deploymentName = adapters.deploymentName ?? deploymentNameOf(repository);
  const { accountId, cf } = await resolveAuth(
    { ...opts, ...(adapters.client ? { client: adapters.client } : {}) },
    env,
  );
  const remoteSecrets = await listScriptSecrets(cf, accountId, deploymentName);
  const missingSecrets = registry.flatMap((w) =>
    w.def.secrets
      .filter((name) => !env[name] && !remoteSecrets.has(name))
      .map((name) => `${w.def.id}.${name}`),
  );
  if (missingSecrets.length > 0) {
    throw new Error(`missing secret(s): ${missingSecrets.join(", ")}`);
  }

  validateBindings(secrets);
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
    accountId,
    ...opts,
    deploymentName,
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
  const dataBucket = DATA_BUCKET;
  const stateBucket = STATE_BUCKET;
  const repositoryId =
    repository.authentication.type === "github"
      ? `github:${repository.authentication.repository.id}`
      : `source:${createHash("sha256").update(repository.remote).digest("hex")}`;
  const allSecretNames = [...new Set([...remoteSecrets, ...Object.keys(secretBindings)])].sort();
  const snapshotKeyBindings = allSecretNames.filter((name) =>
    name.startsWith(`${SECRET_SNAPSHOT_KEY_BINDING}_`),
  );
  const manifest = cloudflareStackManifest({
    accountId,
    repositoryId,
    name: deploymentName,
    deployment,
    schedules: cronsOf(registry),
    secretNames: allSecretNames,
    snapshotKeyBindings,
    dataBucket,
    stateBucket,
  });
  const control =
    adapters.stack?.(manifest) ??
    new CloudflareStackControl({
      cf,
      accountId,
      registry,
      deployment,
      secretBindings,
      stateBucket,
      ready: adapters.ready ?? waitUntilReady,
    });
  const stack = new Stack(manifest, control);
  await stack.sync();

  opts.onProgress?.({ step: "deploy", status: "done" });
  return {
    name: deploymentName,
    artifactVersions: deployment.artifacts.map(({ artifactVersion }) => artifactVersion),
    urls: control.urls(),
    remove: async () => {
      await stack.remove();
    },
  };
};

export const deploy = async (registry: Registry, opts: DeployContext): Promise<DeployOutput> =>
  await deployWithAdapters(registry, opts, {});
