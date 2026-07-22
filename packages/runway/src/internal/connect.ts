import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import process from "node:process";
import { promisify } from "node:util";

import pkg from "../../package.json" with { type: "json" };
import { resolveAuth } from "./auth.ts";
import { collectResultItems, resultOf, type CloudflareApi } from "./cloudflare.ts";
import { buildRelease } from "./publish/artifacts.ts";
import { deploymentNameOf } from "./publish/name.ts";
import { publishWithAdapters, type PublishAdapters } from "./publish/publish.ts";
import { cronsOf, secretNamesOf, type Registry } from "./publish/registry.ts";
import { HttpReleaseControl } from "./release/http.ts";
import { RELEASE_TOKEN_BINDING } from "./runtime/contract.ts";
import { resolveRepositorySource, type RepositorySource } from "./source/repository.ts";

const execFileAsync = promisify(execFile);

export const assertCleanWorktree = async (cwd: string): Promise<void> => {
  let status: string;
  try {
    ({ stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
      { cwd, encoding: "utf8" },
    ));
  } catch (error) {
    throw new Error("could not inspect Git worktree", { cause: error });
  }
  if (status.length > 0) {
    throw new Error("Git worktree is dirty; commit or remove local changes before continuing");
  }
  const { stdout: ignoredWorkflows } = await execFileAsync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--", ".runway/workflows"],
    { cwd, encoding: "utf8" },
  );
  if (ignoredWorkflows.length > 0) {
    throw new Error("ignored workflow files cannot be published");
  }
};

interface ConnectContext {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly interactive?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

interface ConnectAdapters {
  readonly resolveAuth?: typeof resolveAuth;
  readonly publish?: Omit<PublishAdapters, "client">;
}

export interface ConnectOutput {
  readonly name: string;
  readonly defaultBranch: string;
  readonly urls: readonly { readonly id: string; readonly url: string }[];
}

const githubNameOf = (repository: RepositorySource): { owner: string; name: string } => {
  let remote: URL;
  try {
    remote = new URL(repository.remote);
  } catch {
    throw new Error("GitHub connection requires a github.com repository remote");
  }
  const [owner, rawName, ...extra] = remote.pathname.replace(/^\//, "").split("/");
  const name = rawName?.replace(/\.git$/, "");
  if (
    remote.protocol !== "https:" ||
    remote.hostname.toLowerCase() !== "github.com" ||
    remote.username ||
    remote.password ||
    !owner ||
    !name ||
    extra.length > 0
  ) {
    throw new Error("GitHub connection requires a github.com repository remote");
  }
  return { owner, name };
};

const githubRepository = async (
  repository: RepositorySource,
  request: typeof globalThis.fetch,
): Promise<{
  readonly ownerId: string;
  readonly owner: string;
  readonly id: string;
  readonly name: string;
  readonly defaultBranch: string;
}> => {
  const identity = githubNameOf(repository);
  const response = await request(
    `https://api.github.com/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.name)}`,
    { headers: { accept: "application/vnd.github+json", "user-agent": `runway/${pkg.version}` } },
  );
  if (!response.ok) {
    throw new Error(
      "GitHub repository metadata is unavailable; private repository connection will be automated with the conditional GitHub App flow",
    );
  }
  const value = (await response.json()) as Record<string, unknown>;
  const owner = value.owner as Record<string, unknown> | undefined;
  if (
    typeof value.id !== "number" ||
    typeof value.name !== "string" ||
    typeof value.default_branch !== "string" ||
    typeof owner?.id !== "number" ||
    typeof owner.login !== "string"
  ) {
    throw new Error("GitHub returned invalid repository metadata");
  }
  return {
    ownerId: String(owner.id),
    owner: owner.login,
    id: String(value.id),
    name: value.name,
    defaultBranch: value.default_branch,
  };
};

const required = (value: unknown, message: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
};

const workerTagOf = async (cf: CloudflareApi, accountId: string, name: string): Promise<string> => {
  const scripts = await collectResultItems(
    await cf.workers.scripts.list({ account_id: accountId }),
    (item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : undefined),
  );
  const script = scripts.find(({ id }) => id === name);
  return required(script?.tag, "Cloudflare Worker has no Builds tag");
};

const resultRecord = (value: unknown): Record<string, unknown> => {
  const result = resultOf(value);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Cloudflare Builds returned an invalid response");
  }
  return result as Record<string, unknown>;
};

interface PreparedBuilds {
  readonly connectionId: string;
  readonly buildTokenId: string;
}

const prepareBuilds = async (opts: {
  readonly cf: CloudflareApi;
  readonly accountId: string;
  readonly repository: Awaited<ReturnType<typeof githubRepository>>;
}): Promise<PreparedBuilds> => {
  let tokens: readonly Record<string, unknown>[];
  try {
    tokens = await collectResultItems(
      await opts.cf.builds.tokens.list({ account_id: opts.accountId }),
      (item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : undefined),
    );
  } catch (error) {
    throw new Error(
      "Workers Builds setup requires a user API token with Workers Builds Configuration: Edit; set CLOUDFLARE_API_TOKEN and rerun `runway connect github`",
      { cause: error },
    );
  }
  const preferred =
    tokens.find(({ build_token_name: name }) => name === "Runway releases") ??
    (tokens.length === 1 ? tokens[0] : undefined);
  const buildTokenId = preferred?.build_token_uuid;
  if (typeof buildTokenId !== "string") {
    throw new Error(
      "Create or select a Workers Builds deploy token from the Worker's Settings > Builds page, then rerun `runway connect github`",
    );
  }

  let connection: Record<string, unknown>;
  try {
    connection = resultRecord(
      await opts.cf.builds.repos.connections.upsert({
        account_id: opts.accountId,
        provider_type: "github",
        provider_account_id: opts.repository.ownerId,
        provider_account_name: opts.repository.owner,
        repo_id: opts.repository.id,
        repo_name: opts.repository.name,
      }),
    );
  } catch (error) {
    throw new Error(
      "Authorize the Cloudflare Workers and Pages GitHub App from the Worker's Settings > Builds page, then rerun `runway connect github`",
      { cause: error },
    );
  }
  return {
    connectionId: required(
      connection.repo_connection_uuid,
      "Cloudflare Builds returned no repository connection",
    ),
    buildTokenId,
  };
};

const configureBuilds = async (opts: {
  readonly cf: CloudflareApi;
  readonly accountId: string;
  readonly workerTag: string;
  readonly repository: Awaited<ReturnType<typeof githubRepository>>;
  readonly prepared: PreparedBuilds;
  readonly releaseToken: string;
  readonly releaseUrl: string;
}): Promise<void> => {
  const mutable = {
    build_token_uuid: opts.prepared.buildTokenId,
    trigger_name: "Runway releases",
    build_command: "",
    deploy_command: "npx --no-install runway internal release",
    root_directory: "/",
    branch_includes: [opts.repository.defaultBranch],
    branch_excludes: [],
    path_includes: ["*"],
    path_excludes: [],
    build_caching_enabled: true,
  };
  const desired = {
    ...mutable,
    external_script_id: opts.workerTag,
    repo_connection_uuid: opts.prepared.connectionId,
  };
  const triggers = await collectResultItems(
    await opts.cf.builds.triggers.list(opts.workerTag, { account_id: opts.accountId }),
    (item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : undefined),
  );
  const current = triggers.find(({ trigger_name: name }) => name === desired.trigger_name);
  const triggerId = current?.trigger_uuid ?? current?.id;
  let configuredId: string;
  if (typeof triggerId === "string") {
    await opts.cf.builds.triggers.update(triggerId, { account_id: opts.accountId, ...mutable });
    configuredId = triggerId;
  } else {
    const created = resultRecord(
      await opts.cf.builds.triggers.create({ account_id: opts.accountId, ...desired }),
    );
    configuredId = required(
      created.trigger_uuid ?? created.id,
      "Cloudflare Builds returned no trigger identity",
    );
  }
  await opts.cf.builds.triggers.environmentVariables.update(configuredId, {
    account_id: opts.accountId,
    variables: {
      [RELEASE_TOKEN_BINDING]: { value: opts.releaseToken, is_secret: true },
      RUNWAY_RELEASE_URL: { value: opts.releaseUrl, is_secret: false },
      RUNWAY_ACCOUNT_ID: { value: opts.accountId, is_secret: false },
    },
  });
};

export const connectGitHub = async (
  registry: Registry,
  opts: ConnectContext,
  adapters: ConnectAdapters = {},
): Promise<ConnectOutput> => {
  const env = opts.env ?? process.env;
  const repository = await resolveRepositorySource(opts.cwd);
  await assertCleanWorktree(opts.cwd);
  const metadata = await githubRepository(repository, opts.fetch ?? globalThis.fetch);
  const auth = adapters.resolveAuth ?? resolveAuth;
  const { accountId, cf: buildsCf } = await auth(
    {
      cwd: opts.cwd,
      wranglerAuth: true,
      ...(opts.interactive === undefined ? {} : { interactive: opts.interactive }),
    },
    env,
  );
  const prepared = await prepareBuilds({ cf: buildsCf, accountId, repository: metadata });
  let stackCf = buildsCf;
  let stackEnv = env;
  if (env.CLOUDFLARE_API_TOKEN) {
    const wranglerEnv = {
      ...env,
      CLOUDFLARE_API_TOKEN: undefined,
      CLOUDFLARE_ACCOUNT_ID: accountId,
    };
    try {
      stackCf = (
        await auth(
          {
            cwd: opts.cwd,
            wranglerAuth: true,
            ...(opts.interactive === undefined ? {} : { interactive: opts.interactive }),
          },
          wranglerEnv,
        )
      ).cf;
      stackEnv = wranglerEnv;
    } catch {
      stackCf = buildsCf;
    }
  }
  const buildsToken = env.CLOUDFLARE_API_TOKEN;
  if (!buildsToken) {
    throw new Error("Workers Builds setup requires CLOUDFLARE_API_TOKEN during connection");
  }
  const releaseToken = createHmac("sha256", buildsToken)
    .update(`runway-release\0${accountId}\0${metadata.id}`)
    .digest("base64url");
  const connectedEnv = {
    ...stackEnv,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    RUNWAY_DEFAULT_BRANCH: metadata.defaultBranch,
    [RELEASE_TOKEN_BINDING]: releaseToken,
  };
  const published = await publishWithAdapters(
    registry,
    {
      cwd: opts.cwd,
      env: connectedEnv,
      wranglerAuth: true,
      activateRelease: false,
      ...(opts.interactive === undefined ? {} : { interactive: opts.interactive }),
    },
    { ...adapters.publish, client: () => stackCf },
  );
  const account = resultRecord(await stackCf.workers.subdomains.get({ account_id: accountId }));
  const subdomain = required(account.subdomain, "Cloudflare account has no workers.dev subdomain");
  const releaseUrl = `https://${published.name}.${subdomain}.workers.dev/runway/release`;
  const releases = new HttpReleaseControl({
    url: releaseUrl,
    token: releaseToken,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const current = await releases.current();
  await releases.activate(published.release, current?.active ?? null);
  await configureBuilds({
    cf: buildsCf,
    accountId,
    workerTag: await workerTagOf(stackCf, accountId, published.name),
    repository: metadata,
    prepared,
    releaseToken,
    releaseUrl,
  });
  return { name: published.name, defaultBranch: metadata.defaultBranch, urls: published.urls };
};

const same = (left: readonly string[], right: readonly string[]): boolean =>
  [...left].sort().join("\0") === [...right].sort().join("\0");

const isAncestor = async (cwd: string, ancestor: string, descendant: string): Promise<boolean> => {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw new Error("cannot prove release commit ancestry", { cause: error });
  }
};

export const assertWorkersBuildEnvironment = (env: NodeJS.ProcessEnv): void => {
  if (env.WORKERS_CI !== "1") throw new Error("internal release requires Workers Builds");
};

export const releaseFromBuild = async (
  registry: Registry,
  opts: ConnectContext,
): Promise<{ readonly changed: boolean; readonly registryVersion: string }> => {
  const env = opts.env ?? process.env;
  assertWorkersBuildEnvironment(env);
  const repository = await resolveRepositorySource(opts.cwd);
  await assertCleanWorktree(opts.cwd);
  if (env.WORKERS_CI_COMMIT_SHA !== repository.commit) {
    throw new Error("Workers Builds commit does not match the checked out repository");
  }
  if (env.WORKERS_CI_BRANCH === undefined) throw new Error("Workers Builds branch is missing");
  const deploymentName = deploymentNameOf(repository);
  const releaseUrl = env.RUNWAY_RELEASE_URL;
  const releaseToken = env[RELEASE_TOKEN_BINDING];
  const accountId = env.RUNWAY_ACCOUNT_ID;
  if (!releaseUrl || !releaseToken || !accountId) {
    throw new Error("Workers Builds release capability is missing");
  }
  const control = new HttpReleaseControl({
    url: releaseUrl,
    token: releaseToken,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const current = await control.current();
  if (!current) throw new Error("repository is not connected; run `runway connect github`");
  if (!current.registry.defaultBranch || env.WORKERS_CI_BRANCH !== current.registry.defaultBranch) {
    throw new Error("Workers Builds release is not from the connected default branch");
  }
  const source: RepositorySource = {
    ...repository,
    authentication: current.registry.repository.authentication,
  };
  const release = await buildRelease(registry, {
    accountId,
    cwd: opts.cwd,
    deploymentName,
    defaultBranch: current.registry.defaultBranch,
    repository: source,
    snapshotKeyAvailable: true,
    ...(current.registry.github && registry.some(({ def }) => def.trigger?.type === "github")
      ? { github: current.registry.github }
      : {}),
  });
  if (
    release.registry.routes.some((route) => route.type === "github") &&
    !current.registry.github
  ) {
    throw new Error("GitHub triggers were added; rerun `runway connect github`");
  }
  if (!same(release.registry.secretNames, current.registry.secretNames)) {
    throw new Error("workflow secret declarations changed; rerun `runway connect github`");
  }
  if (
    !same(
      cronsOf(registry),
      current.registry.routes
        .filter((route) => route.type === "cron")
        .map(({ expression }) => expression),
    )
  ) {
    throw new Error("workflow schedules changed; rerun `runway connect github`");
  }
  if (!same(secretNamesOf(registry), release.registry.secretNames)) {
    throw new Error("invalid release secret declarations");
  }
  if (!(await isAncestor(opts.cwd, current.active.commit, repository.commit))) {
    throw new Error(`release ${repository.commit} was superseded by ${current.active.commit}`);
  }
  const activated = await control.activate(release, current.active);
  return { changed: activated.changed, registryVersion: release.registryVersion };
};
