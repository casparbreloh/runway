import {
  createDynamicWorkflowEntrypoint,
  wrapWorkflowBinding,
  type WorkflowRunner as DynamicRun,
} from "@cloudflare/dynamic-workflows";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";

import { cloudflareSandbox } from "./cloudflare/sandbox.ts";
import type {
  GitHubCoordinatorAdmission,
  GitHubCoordinatorRun,
  RunwayGitHubCoordinator,
} from "./github-coordinator.ts";
import {
  createGitHubProvider,
  matchGitHubDelivery,
  normalizeGitHubDelivery,
  type GitHubAcceptedDelivery,
} from "./github.ts";
import {
  parseGitHubRunSource,
  repositorySourceForRun,
  sourceIdentity,
  type GitHubRunSource,
  type RepositorySource,
} from "./repository-source.ts";
import type { ExecResult } from "./run.ts";
import type { RuntimeBinding } from "./runtime-binding.ts";
import { GITHUB_COORDINATOR_BINDING, SANDBOX_BINDING } from "./sandbox-config.ts";
import { createSecretSnapshots } from "./secret-snapshot.ts";
import type { PreparedSource, SourceIdentity } from "./source.ts";
import type { Finalization, TerminalIdentity } from "./terminal.ts";
import type { GitHubEventFilter, GitHubRepository } from "./types.ts";
import {
  ARTIFACT_BUCKET_BINDING,
  COMPATIBILITY_DATE,
  isSecretSnapshotKeyBinding,
  LOADER_BINDING,
  RUNTIME_BINDING,
  RUNWAY_WORKFLOW_CLASS,
  SECRET_SNAPSHOT_KEY_BINDING,
  WORKFLOW_BINDING,
} from "./worker-contract.ts";
import { decodeWorkflowArtifact, workflowArtifactKey } from "./workflow-artifact.ts";
import type { WorkflowArtifact } from "./workflow-artifact.ts";

export { RunwayGitHubCoordinator } from "./github-coordinator.ts";

const CACHE_PATH = /^\/\.runway\/cache\/([0-9a-f]{64})\.tar\.gz$/;

const workflowCacheKey = (digest: string): string => `caches/${digest}.tar.gz`;

interface LoaderStub {
  getEntrypoint(name?: string): { fetch(req: Request): Promise<Response>; run?: unknown };
}

interface LoaderBinding {
  get(
    name: string,
    init: () => Promise<{
      compatibilityDate: string;
      compatibilityFlags?: ReadonlyArray<string>;
      mainModule: string;
      modules: Record<string, string>;
      env: Record<string, unknown>;
    }>,
  ): LoaderStub;
}

interface HostEnv {
  [LOADER_BINDING]: LoaderBinding;
  [ARTIFACT_BUCKET_BINDING]: R2Bucket;
  [SECRET_SNAPSHOT_KEY_BINDING]: string;
  [SANDBOX_BINDING]: DurableObjectNamespace<Sandbox>;
  [WORKFLOW_BINDING]: Workflow;
  [GITHUB_COORDINATOR_BINDING]?: DurableObjectNamespace<RunwayGitHubCoordinator>;
  RUNWAY_GITHUB_APP_ID?: string;
  RUNWAY_GITHUB_PRIVATE_KEY?: string;
  RUNWAY_GITHUB_WEBHOOK_SECRET?: string;
}

interface HostProps {
  readonly repository: RepositorySource;
  readonly source?: GitHubRunSource;
  readonly secretNames: ReadonlyArray<string>;
  readonly secretSnapshotKey: string;
  readonly snapshotScope: string;
  readonly terminal: Omit<TerminalIdentity, "runId">;
}

interface LoaderContext {
  exports: {
    RunwaySandboxBinding(options: { props: HostProps }): RuntimeBinding;
  };
}

type HostRoute =
  | {
      readonly id: string;
      readonly artifactVersion: string;
      readonly type: "webhook";
      readonly path: string;
    }
  | {
      readonly id: string;
      readonly artifactVersion: string;
      readonly type: "cron";
      readonly expression: string;
    }
  | {
      readonly id: string;
      readonly artifactVersion: string;
      readonly type: "github";
      readonly checkName: string;
      readonly events: readonly GitHubEventFilter[];
    };

export interface HostConfig {
  readonly accountId: string;
  readonly scriptName: string;
  readonly deploymentId: string;
  readonly secretSnapshotKey: string;
  readonly routes: ReadonlyArray<HostRoute>;
  readonly github?: {
    readonly repository: GitHubRepository;
    readonly installationId: number;
  };
}

export class RunwaySandboxBinding
  extends WorkerEntrypoint<HostEnv, HostProps>
  implements RuntimeBinding
{
  async startRun(runId: string): Promise<boolean> {
    this.#assertRun(runId);
    const source = this.ctx.props.source;
    if (!source) return true;
    const namespace = this.env[GITHUB_COORDINATOR_BINDING];
    if (!namespace) throw new Error("GitHub coordinator is not configured");
    const result = await namespace.getByName(String(source.check.repository.id)).lifecycle({
      source,
      state: "in_progress",
    });
    if (typeof result?.proceed !== "boolean") throw new Error("invalid GitHub run lifecycle");
    return result.proceed;
  }

  async terminal(runId: string): Promise<TerminalIdentity> {
    this.#assertRun(runId);
    return { ...this.ctx.props.terminal, runId };
  }

  async publishTerminal(runId: string, finalization: Finalization): Promise<void> {
    this.#assertRun(runId);
    if (
      !finalization ||
      typeof finalization !== "object" ||
      Object.keys(finalization).sort().join(",") !== "claimId,outcome" ||
      typeof finalization.claimId !== "string" ||
      finalization.claimId.length === 0 ||
      !["success", "failure", "cancelled"].includes(finalization.outcome)
    ) {
      throw new Error("invalid terminal finalization");
    }
    const source = this.ctx.props.source;
    if (!source) return;
    const namespace = this.env[GITHUB_COORDINATOR_BINDING];
    if (!namespace) throw new Error("GitHub coordinator is not configured");
    const result = await namespace.getByName(String(source.check.repository.id)).lifecycle({
      source,
      state: finalization.outcome === "success" ? "success" : "failure",
    });
    if (typeof result?.proceed !== "boolean") throw new Error("invalid GitHub run lifecycle");
  }

  #assertRun(runId: string): void {
    if (typeof runId !== "string" || runId.length === 0) throw new Error("invalid run lifecycle");
    const source = this.ctx.props.source;
    if (source && source.runId !== runId) throw new Error("invalid GitHub run lifecycle");
  }

  #secretValues(): Readonly<Record<string, string>> {
    const parentEnv = this.env as unknown as Record<string, unknown>;
    return Object.fromEntries(
      this.ctx.props.secretNames.map((name) => {
        const value = parentEnv[name];
        if (typeof value !== "string") throw new Error(`missing secret: ${name}`);
        return [name, value];
      }),
    );
  }

  #sandbox(): ReturnType<typeof cloudflareSandbox> {
    return cloudflareSandbox({
      placement: (sandboxId) =>
        getSandbox(this.env[SANDBOX_BINDING], sandboxId, { enableDefaultSession: false }),
      status: async (runId) => await (await this.env[WORKFLOW_BINDING].get(runId)).status(),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      repository: this.ctx.props.repository,
      installationToken: async ({ authentication, purpose }) => {
        const appId = this.env.RUNWAY_GITHUB_APP_ID;
        const privateKey = this.env.RUNWAY_GITHUB_PRIVATE_KEY;
        if (typeof appId !== "string" || typeof privateKey !== "string") {
          throw new Error("missing GitHub App credentials");
        }
        return (
          await createGitHubProvider({ appId, privateKey }).createInstallationToken({
            installationId: authentication.installationId,
            repository: authentication.repository,
            purpose,
          })
        ).token;
      },
      log: ({ stream, chunk }) => {
        if (stream === "stdout") console.log(chunk);
        else console.error(chunk);
      },
    });
  }

  #snapshotValues(secrets: Readonly<Record<string, string>>): ReadonlyArray<string> {
    const names = Object.keys(secrets).sort();
    const declared = [...this.ctx.props.secretNames].sort();
    if (
      names.length !== declared.length ||
      names.some((name, index) => name !== declared[index] || typeof secrets[name] !== "string")
    ) {
      throw new Error("invalid secret snapshot");
    }
    return Object.values(secrets);
  }

  async #snapshotKey(
    binding: string,
  ): Promise<{ readonly identity: string; readonly key: CryptoKey }> {
    if (!isSecretSnapshotKeyBinding(binding)) throw new Error("invalid secret snapshot");
    const encoded = (this.env as unknown as Record<string, unknown>)[binding];
    if (typeof encoded !== "string") throw new Error("invalid secret snapshot key");
    let stored: unknown;
    try {
      stored = JSON.parse(encoded);
    } catch {
      throw new Error("invalid secret snapshot key");
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      throw new Error("invalid secret snapshot key");
    }
    const record = stored as Record<string, unknown>;
    const { identity } = record;
    if (binding === SECRET_SNAPSHOT_KEY_BINDING) {
      if (
        Object.keys(record).join(",") !== "identity" ||
        typeof identity !== "string" ||
        identity === SECRET_SNAPSHOT_KEY_BINDING ||
        !isSecretSnapshotKeyBinding(identity)
      ) {
        throw new Error("invalid secret snapshot key");
      }
      return await this.#snapshotKey(identity);
    }
    const { key } = record;
    if (
      Object.keys(record).sort().join(",") !== "identity,key" ||
      typeof identity !== "string" ||
      binding !== identity ||
      typeof key !== "string" ||
      !isSecretSnapshotKeyBinding(identity)
    ) {
      throw new Error("invalid secret snapshot key");
    }
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(key), (character) => character.charCodeAt(0));
    } catch {
      throw new Error("invalid secret snapshot key");
    }
    if (bytes.byteLength !== 32) throw new Error("invalid secret snapshot key");
    return {
      identity,
      key: await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]),
    };
  }

  #snapshots(): ReturnType<typeof createSecretSnapshots> {
    return createSecretSnapshots({
      scope: this.ctx.props.snapshotScope,
      secretNames: this.ctx.props.secretNames,
      key: (binding) => this.#snapshotKey(binding),
    });
  }

  async secrets(): Promise<Readonly<Record<string, string>>> {
    return this.#secretValues();
  }

  async captureSecrets(runId: string): Promise<string> {
    return await this.#snapshots().capture(
      runId,
      this.ctx.props.secretSnapshotKey,
      this.#secretValues(),
    );
  }

  async restoreSecrets(runId: string, snapshot: string): Promise<Readonly<Record<string, string>>> {
    return await this.#snapshots().restore(runId, snapshot);
  }

  async source(): Promise<SourceIdentity> {
    return sourceIdentity(this.ctx.props.repository);
  }

  async prepareSource(request: {
    readonly runId: string;
    readonly source: SourceIdentity;
    readonly secrets: Readonly<Record<string, string>>;
    readonly allowReconstruct: boolean;
  }): Promise<PreparedSource> {
    const expected = sourceIdentity(this.ctx.props.repository);
    if (
      request.source.repositoryId !== expected.repositoryId ||
      request.source.remote !== expected.remote ||
      request.source.revision !== expected.revision
    ) {
      throw new Error("source preparation does not match the bound repository");
    }
    return await this.#sandbox().prepare({
      runId: request.runId,
      secrets: this.#snapshotValues(request.secrets),
      allowReconstruct: request.allowReconstruct,
    });
  }

  async execute(request: Parameters<RuntimeBinding["execute"]>[0]): Promise<ExecResult> {
    const { secrets, ...command } = request;
    return await this.#sandbox().execute({
      ...command,
      secrets: this.#snapshotValues(secrets),
    });
  }

  async destroy(runId: string, secrets: Readonly<Record<string, string>>): Promise<void> {
    await this.#sandbox().destroy(runId, this.#snapshotValues(secrets));
  }
}

interface WorkflowMetadata extends Readonly<Record<string, unknown>> {
  readonly artifactVersion: string;
  readonly source?: GitHubRunSource;
}

type LoaderPurpose = "trigger" | "run";

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = async (bytes: BufferSource): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", bytes));

const metadataOf = (value: unknown): WorkflowMetadata => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["artifactVersion", "artifactVersion,source"].includes(Object.keys(value).sort().join(","))
  ) {
    throw new Error("invalid workflow metadata");
  }
  const { artifactVersion, source } = value as Record<string, unknown>;
  if (typeof artifactVersion !== "string" || !/^[0-9a-f]{64}$/.test(artifactVersion)) {
    throw new Error("invalid workflow metadata");
  }
  if (source === undefined) return { artifactVersion };
  try {
    return { artifactVersion, source: parseGitHubRunSource(source) };
  } catch {
    throw new Error("invalid workflow metadata");
  }
};

const readArtifact = async (
  env: HostEnv,
  value: unknown,
  config: HostConfig,
): Promise<{ readonly artifact: WorkflowArtifact; readonly metadata: WorkflowMetadata }> => {
  const metadata = metadataOf(value);
  const object = await env[ARTIFACT_BUCKET_BINDING].get(
    workflowArtifactKey(metadata.artifactVersion),
  );
  if (!object) throw new Error("missing workflow artifact");
  const bytes = await object.arrayBuffer();
  if ((await sha256(bytes)) !== metadata.artifactVersion) {
    throw new Error("invalid workflow artifact hash");
  }
  const artifact = decodeWorkflowArtifact(bytes);
  if (artifact.scriptName !== config.scriptName)
    throw new Error("workflow artifact does not match route");
  return { artifact, metadata };
};

const loadWorker = async (
  env: HostEnv,
  ctx: LoaderContext,
  config: HostConfig,
  purpose: LoaderPurpose,
  artifact: WorkflowArtifact,
  metadata: WorkflowMetadata,
): Promise<LoaderStub> => {
  const repository = metadata.source
    ? repositorySourceForRun(metadata.source)
    : artifact.repository;
  const repositoryId = sourceIdentity(repository).repositoryId;
  const identity = new TextEncoder().encode(
    JSON.stringify([purpose, metadata.artifactVersion, config.deploymentId, metadata.source]),
  );
  const loaderId = await sha256(identity);
  return env[LOADER_BINDING].get(loaderId, async () => ({
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "index.js",
    modules: { "index.js": artifact.source },
    env: {
      [RUNTIME_BINDING]: ctx.exports.RunwaySandboxBinding({
        props: {
          repository,
          ...(metadata.source ? { source: metadata.source } : {}),
          secretNames: artifact.secrets,
          secretSnapshotKey: config.secretSnapshotKey,
          snapshotScope: `${config.scriptName}:${artifact.workflowId}:${metadata.artifactVersion}`,
          terminal: {
            accountId: config.accountId,
            repositoryId,
            workflowId: artifact.workflowId,
            trustId: repositoryId,
            generation: metadata.source?.generation ?? 1,
          },
        },
      }),
      [WORKFLOW_BINDING]: wrapWorkflowBinding(metadata),
    },
  }));
};

export const createDynamicWorkflow = (config: HostConfig) =>
  createDynamicWorkflowEntrypoint<HostEnv>(async ({ env, metadata, ctx }) => {
    const loaded = await readArtifact(env, metadata, config);
    const worker = await loadWorker(
      env,
      ctx as unknown as LoaderContext,
      config,
      "run",
      loaded.artifact,
      loaded.metadata,
    );
    return worker.getEntrypoint(RUNWAY_WORKFLOW_CLASS) as unknown as DynamicRun;
  });

const dynamicFetch = async (
  route: HostRoute,
  request: Request,
  env: HostEnv,
  ctx: LoaderContext,
  config: HostConfig,
): Promise<Response> => {
  const loaded = await readArtifact(env, { artifactVersion: route.artifactVersion }, config);
  if (loaded.artifact.workflowId !== route.id) {
    throw new Error("workflow artifact does not match route");
  }
  const worker = await loadWorker(env, ctx, config, "trigger", loaded.artifact, loaded.metadata);
  return await worker.getEntrypoint().fetch(request);
};

export const createHost = (config: HostConfig) => ({
  async fetch(req: Request, env: HostEnv, ctx: LoaderContext): Promise<Response> {
    const url = new URL(req.url);
    const cache = req.method === "GET" ? CACHE_PATH.exec(url.pathname) : null;
    if (cache) {
      const object = await env[ARTIFACT_BUCKET_BINDING].get(workflowCacheKey(cache[1]!));
      if (!object) return new Response("not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "Cache-Control": "public, max-age=31536000, immutable",
          "Content-Type": "application/gzip",
          ETag: object.httpEtag,
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/.runway/version") {
      return Response.json(
        { deploymentId: config.deploymentId },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const pathname = url.pathname;
    if (pathname === "/.runway/github" && req.method === "POST") {
      if (!config.github) return new Response("not found", { status: 404 });
      const secret = env.RUNWAY_GITHUB_WEBHOOK_SECRET;
      if (typeof secret !== "string" || secret.length === 0) {
        return new Response("GitHub webhook is not configured", { status: 503 });
      }
      const routes = config.routes.filter((route) => route.type === "github");
      let delivery: GitHubAcceptedDelivery | undefined;
      const workflows: GitHubCoordinatorAdmission["workflows"][number][] = [];
      try {
        const normalized = await normalizeGitHubDelivery(req, {
          repository: config.github.repository,
          installationId: config.github.installationId,
          webhookSecret: secret,
        });
        for (const route of routes) {
          const parsed = matchGitHubDelivery(normalized, route.events);
          if (parsed.status === "accepted") {
            delivery ??= parsed;
            workflows.push({
              workflowId: route.id,
              artifactVersion: route.artifactVersion,
              checkName: route.checkName,
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid GitHub webhook";
        return new Response("invalid GitHub webhook", {
          status: message === "invalid GitHub webhook signature" ? 401 : 400,
        });
      }
      if (!delivery || workflows.length === 0) return Response.json({ skipped: true });
      const namespace = env[GITHUB_COORDINATOR_BINDING];
      if (!namespace) return new Response("GitHub coordinator is not configured", { status: 503 });
      const coordinator = namespace.getByName(String(config.github.repository.id));
      const result = (await coordinator.admit({ delivery, workflows })) as {
        readonly runs: readonly GitHubCoordinatorRun[];
      };
      return Response.json({ runs: result.runs }, { status: 202 });
    }
    const matches = config.routes.filter(
      (route) => route.type === "webhook" && route.path === pathname && req.method === "POST",
    );
    if (matches.length === 0) return new Response("not found", { status: 404 });
    const runs: Array<{ id: string; workflow: string }> = [];
    for (const route of matches) {
      const response = await dynamicFetch(route, req.clone(), env, ctx, config);
      if (response.status === 202) {
        const result = (await response.json()) as {
          runs: Array<{ id: string; workflow: string }>;
        };
        runs.push(...result.runs);
      } else if (response.ok) {
        const result = (await response.json()) as { skipped?: unknown };
        if (result.skipped !== true) {
          return new Response("invalid workflow response", { status: 500 });
        }
      } else {
        return response;
      }
    }
    return runs.length > 0
      ? Response.json({ runs }, { status: 202 })
      : Response.json({ skipped: true });
  },

  async scheduled(
    event: { readonly cron: string; readonly scheduledTime: number },
    env: HostEnv,
    ctx: LoaderContext,
  ): Promise<void> {
    await Promise.all(
      config.routes
        .filter((route) => route.type === "cron" && route.expression === event.cron)
        .map(async (route) => {
          const response = await dynamicFetch(
            route,
            new Request("https://runway.local/.runway/scheduled", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-runway-trigger": "scheduled",
              },
              body: JSON.stringify(event),
            }),
            env,
            ctx,
            config,
          );
          if (!response.ok) throw new Error(await response.text());
        }),
    );
  },
});
