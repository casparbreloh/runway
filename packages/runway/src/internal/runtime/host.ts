import {
  createDynamicWorkflowEntrypoint,
  wrapWorkflowBinding,
  type WorkflowRunner as DynamicRun,
} from "@cloudflare/dynamic-workflows";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";

import type { ExecResult } from "../../step.ts";
import type { GitHubEventFilter, GitHubRepository } from "../../trigger.ts";
import { Cache } from "../cache/cache.ts";
import { normalizedCacheTarget } from "../cache/path.ts";
import { CloudflareCacheSnapshot } from "../cache/snapshot.ts";
import { CloudflareCacheTransfer } from "../cache/transfer.ts";
import type {
  GitHubCoordinatorAdmission,
  GitHubCoordinatorRun,
  RunwayGitHubCoordinator,
} from "../github/coordinator.ts";
import {
  matchGitHubDelivery,
  normalizeGitHubDelivery,
  type GitHubAcceptedDelivery,
} from "../github/delivery.ts";
import { createGitHubProvider } from "../github/provider.ts";
import { CLOUDFLARE_PRICE_TABLE, emitMeterReport, Meter, type MeterReport } from "../meter.ts";
import { cloudflareSandbox } from "../sandbox/cloudflare.ts";
import {
  CACHE_SCHEMA,
  CACHE_LIMITS,
  GITHUB_COORDINATOR_BINDING,
  SANDBOX_BINDING,
  SANDBOX_CAPACITY,
  SANDBOX_RUNNER_ABI,
} from "../sandbox/config.ts";
import { createSecretSnapshots } from "../secret/snapshot.ts";
import {
  parseGitHubRunSource,
  repositorySourceForRun,
  sourceIdentity,
  type GitHubRunSource,
  type RepositorySource,
} from "../source/repository.ts";
import type { PreparedSource, SourceIdentity } from "../source/source.ts";
import { parseFinalization, parseTerminalIdentity, parseTerminalRecord } from "../terminal.ts";
import type { Finalization, TerminalIdentity, TerminalRecord } from "../terminal.ts";
import { decodeWorkflowArtifact, workflowArtifactKey } from "./artifact.ts";
import type { WorkflowArtifact } from "./artifact.ts";
import type { RuntimeBinding } from "./binding.ts";
import {
  DATA_BUCKET_BINDING,
  CACHE_R2_ACCESS_KEY_ID_BINDING,
  CACHE_R2_SECRET_ACCESS_KEY_BINDING,
  CACHE_R2_SESSION_TOKEN_BINDING,
  COMPATIBILITY_DATE,
  isSecretSnapshotKeyBinding,
  LOADER_BINDING,
  RUNTIME_BINDING,
  RUNWAY_WORKFLOW_CLASS,
  SECRET_SNAPSHOT_KEY_BINDING,
  WORKFLOW_BINDING,
} from "./contract.ts";
import { parseFailureDiagnostic } from "./diagnostic.ts";
import type { FailureDiagnostic } from "./diagnostic.ts";

export { RunwayGitHubCoordinator } from "../github/coordinator.ts";

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
  [DATA_BUCKET_BINDING]: R2Bucket;
  [SECRET_SNAPSHOT_KEY_BINDING]: string;
  [SANDBOX_BINDING]: DurableObjectNamespace<Sandbox>;
  [WORKFLOW_BINDING]: Workflow;
  [GITHUB_COORDINATOR_BINDING]?: DurableObjectNamespace<RunwayGitHubCoordinator>;
  RUNWAY_GITHUB_APP_ID?: string;
  RUNWAY_GITHUB_PRIVATE_KEY?: string;
  RUNWAY_GITHUB_WEBHOOK_SECRET?: string;
  [CACHE_R2_ACCESS_KEY_ID_BINDING]?: string;
  [CACHE_R2_SECRET_ACCESS_KEY_BINDING]?: string;
  [CACHE_R2_SESSION_TOKEN_BINDING]?: string;
}

interface HostProps {
  readonly repository: RepositorySource;
  readonly source?: GitHubRunSource;
  readonly secretNames: ReadonlyArray<string>;
  readonly secretSnapshotKey: string;
  readonly snapshotScope: string;
  readonly terminal: Omit<TerminalIdentity, "runId">;
  readonly cache: {
    readonly accountId: string;
    readonly bucket: string;
    readonly admission: {
      readonly type: string;
      readonly ref?: string;
      readonly defaultRef?: string;
      readonly number?: number;
      readonly headRepositoryId?: string;
    };
    readonly repositoryId: string;
    readonly workflowId: string;
    readonly generation: number;
    readonly imageDigest?: string;
  };
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
  readonly cacheBucket: string;
  readonly imageDigest: string;
  readonly deploymentName: string;
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
    return parseTerminalIdentity({ ...this.ctx.props.terminal, runId });
  }

  async claimTerminal(runId: string, candidate: TerminalRecord): Promise<TerminalRecord> {
    this.#assertRun(runId);
    const identity = await this.terminal(runId);
    let parsed: TerminalRecord;
    try {
      parsed = parseTerminalRecord(candidate);
    } catch {
      throw new Error("invalid terminal claim");
    }
    if (
      Object.entries(identity).some(
        ([field, value]) => parsed[field as keyof TerminalIdentity] !== value,
      )
    ) {
      throw new Error("invalid terminal claim");
    }
    const source = this.ctx.props.source;
    if (!source) return parsed;
    const namespace = this.env[GITHUB_COORDINATOR_BINDING];
    if (!namespace) throw new Error("GitHub coordinator is not configured");
    const winner = await namespace
      .getByName(String(source.check.repository.id))
      .claimTerminal({ source, candidate: parsed });
    try {
      return parseTerminalRecord(winner);
    } catch {
      throw new Error("invalid terminal claim");
    }
  }

  async readTerminal(runId: string): Promise<TerminalRecord | undefined> {
    this.#assertRun(runId);
    const source = this.ctx.props.source;
    if (!source) return undefined;
    const namespace = this.env[GITHUB_COORDINATOR_BINDING];
    if (!namespace) throw new Error("GitHub coordinator is not configured");
    const record = await namespace
      .getByName(String(source.check.repository.id))
      .readTerminal(source);
    if (record === undefined) return undefined;
    try {
      return parseTerminalRecord(record);
    } catch {
      throw new Error("invalid terminal claim");
    }
  }

  async reportMeter(runId: string, report: MeterReport): Promise<void> {
    this.#assertRun(runId);
    emitMeterReport(report);
  }

  async publishTerminal(
    runId: string,
    finalization: Finalization,
    diagnosticValue: FailureDiagnostic | null,
  ): Promise<void> {
    this.#assertRun(runId);
    let parsed: Finalization;
    try {
      parsed = parseFinalization(finalization);
    } catch {
      throw new Error("invalid terminal finalization");
    }
    let diagnostic: FailureDiagnostic | null;
    try {
      diagnostic = parseFailureDiagnostic(diagnosticValue);
    } catch {
      throw new Error("invalid terminal diagnostic");
    }
    if (parsed.outcome !== "failure" && diagnostic !== null) {
      throw new Error("invalid terminal diagnostic");
    }
    const source = this.ctx.props.source;
    if (!source) return;
    const namespace = this.env[GITHUB_COORDINATOR_BINDING];
    if (!namespace) throw new Error("GitHub coordinator is not configured");
    await namespace.getByName(String(source.check.repository.id)).publishTerminal({
      source,
      finalization: parsed,
      diagnostic,
    });
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

  #cache(sourceRequest?: {
    readonly runId: string;
    readonly secrets: Readonly<Record<string, string>>;
    readonly source?: PreparedSource;
  }): Cache {
    const config = this.ctx.props.cache;
    const accessKeyId = this.env[CACHE_R2_ACCESS_KEY_ID_BINDING];
    const secretAccessKey = this.env[CACHE_R2_SECRET_ACCESS_KEY_BINDING];
    const sessionToken = this.env[CACHE_R2_SESSION_TOKEN_BINDING];
    const sandbox = this.#sandbox();
    const snapshotSecrets = sourceRequest ? this.#snapshotValues(sourceRequest.secrets) : undefined;
    const meter = new Meter({
      priceTable: CLOUDFLARE_PRICE_TABLE,
      container: SANDBOX_CAPACITY,
      cache: {
        maxBytes: CACHE_LIMITS.maxBytes,
        maxDurationMs: CACHE_LIMITS.helperDurationMs,
        save: {
          classAOperations: CACHE_LIMITS.saveClassAOperations,
          classBOperations: CACHE_LIMITS.saveClassBOperations,
          storageHorizonMs: CACHE_LIMITS.storageHorizonMs,
          transferDurationMs: CACHE_LIMITS.transferDurationMs,
          workflowSteps: CACHE_LIMITS.saveWorkflowSteps,
        },
        restore: {
          classAOperations: CACHE_LIMITS.restoreClassAOperations,
          classBOperations: CACHE_LIMITS.restoreClassBOperations,
          transferDurationMs: CACHE_LIMITS.transferDurationMs,
          workflowSteps: CACHE_LIMITS.restoreWorkflowSteps,
        },
      },
      emit: emitMeterReport,
    });
    const transfer =
      sourceRequest &&
      snapshotSecrets &&
      config.imageDigest &&
      typeof accessKeyId === "string" &&
      accessKeyId.length > 0 &&
      typeof secretAccessKey === "string" &&
      secretAccessKey.length > 0
        ? new CloudflareCacheTransfer({
            accountId: config.accountId,
            bucket: config.bucket,
            accessKeyId,
            secretAccessKey,
            ...(typeof sessionToken === "string" && sessionToken.length > 0
              ? { sessionToken }
              : {}),
            expiresInSeconds: 120,
            log: (entry) => meter.record({ type: "transfer", ...entry }),
            transport: sandbox.cacheTransfer(sourceRequest.runId, snapshotSecrets),
            objects: {
              head: async (key) => {
                const object = await this.env[DATA_BUCKET_BINDING].head(key);
                const digest = object?.customMetadata?.["runway-sha256"];
                return object && typeof digest === "string"
                  ? { bytes: object.size, digest }
                  : undefined;
              },
            },
          })
        : undefined;
    const snapshots =
      transfer && sourceRequest && snapshotSecrets
        ? new CloudflareCacheSnapshot({
            runId: sourceRequest.runId,
            process: async () => await sandbox.cacheProcess(sourceRequest.runId, snapshotSecrets),
            transfer,
          })
        : undefined;
    return new Cache({
      context: {
        repositoryId: config.repositoryId,
        workflowId: config.workflowId,
        generation: config.generation,
        admission: config.admission,
        platform: {
          schema: CACHE_SCHEMA,
          os: "linux",
          architecture: "amd64",
          ...(config.imageDigest ? { imageDigest: config.imageDigest } : {}),
          runnerAbi: SANDBOX_RUNNER_ABI,
        },
      },
      refs: {
        get: async (key) => {
          const object = await this.env[DATA_BUCKET_BINDING].get(key);
          return object ? { etag: object.etag, text: async () => await object.text() } : null;
        },
        list: async (prefix) => {
          const page = await this.env[DATA_BUCKET_BINDING].list({ prefix, limit: 129 });
          return {
            candidates: page.objects.slice(0, 128).map((object) => ({
              key: object.key,
              uploadedAtMs: object.uploaded.getTime(),
            })),
            truncated: page.truncated || page.objects.length > 128,
          };
        },
        put: async (key, text, options) => {
          const object = await this.env[DATA_BUCKET_BINDING].put(key, text, {
            onlyIf: options.onlyIf,
          });
          return object ? { etag: object.etag } : null;
        },
      },
      files: {
        inspect: async (path) => {
          if (!sourceRequest?.source) throw new Error("cache source inspection is unavailable");
          return await this.#sandbox().inspectCacheFile({
            runId: sourceRequest.runId,
            source: sourceRequest.source,
            path,
            secrets: this.#snapshotValues(sourceRequest.secrets),
          });
        },
      },
      current: async () => {
        const source = this.ctx.props.source;
        if (!source) return true;
        const namespace = this.env[GITHUB_COORDINATOR_BINDING];
        if (!namespace) throw new Error("GitHub coordinator is not configured");
        return await namespace.getByName(String(source.check.repository.id)).current(source);
      },
      diagnose: (diagnostic) => console.log({ type: "runway-cache", diagnostic }),
      meter,
      ...(snapshots ? { restore: snapshots, snapshots } : {}),
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

  async restoreCache(
    request: Parameters<RuntimeBinding["restoreCache"]>[0],
  ): ReturnType<RuntimeBinding["restoreCache"]> {
    this.#assertRun(request.runId);
    this.#snapshotValues(request.secrets);
    const expected = sourceIdentity(this.ctx.props.repository);
    if (request.source.result.revision !== expected.revision) {
      throw new Error("cache source does not match the bound repository");
    }
    const cache = this.#cache(request);
    try {
      return await cache.record(request.id, request.declaration);
    } finally {
      await cache.flushMeter();
    }
  }

  async discardCaches(request: Parameters<RuntimeBinding["discardCaches"]>[0]): Promise<void> {
    this.#assertRun(request.runId);
    const process = await this.#sandbox().cacheProcess(
      request.runId,
      Object.values(this.#snapshotValues(request.secrets)),
    );
    try {
      for (const path of request.paths) await process.remove(normalizedCacheTarget(path));
    } finally {
      await process.close();
    }
  }

  async quiesce(runId: string, secrets: Readonly<Record<string, string>>): Promise<void> {
    this.#assertRun(runId);
    await this.#sandbox().quiesce(runId, this.#snapshotValues(secrets));
  }

  async prepareCaches(
    request: Parameters<RuntimeBinding["prepareCaches"]>[0],
  ): ReturnType<RuntimeBinding["prepareCaches"]> {
    this.#assertRun(request.runId);
    this.#snapshotValues(request.secrets);
    const cache = this.#cache(request);
    try {
      return await cache.prepare(request.pending);
    } finally {
      await cache.flushMeter();
    }
  }

  async publishCaches(request: Parameters<RuntimeBinding["publishCaches"]>[0]): Promise<void> {
    this.#assertRun(request.runId);
    this.#snapshotValues(request.secrets);
    if (request.finalization.outcome !== "success") return;
    const source = this.ctx.props.source;
    if (source) {
      const winner = await this.readTerminal(request.runId);
      if (
        !winner ||
        winner.claimId !== request.finalization.claimId ||
        winner.outcome !== request.finalization.outcome
      ) {
        throw new Error("cache publication requires the terminal winner");
      }
    }
    const cache = this.#cache(request);
    try {
      await cache.commit(request.prepared);
    } finally {
      await cache.flushMeter();
    }
  }

  async destroy(runId: string, secrets: Readonly<Record<string, string>>): Promise<void> {
    await this.#sandbox().destroy(runId, this.#snapshotValues(secrets));
  }
}

interface WorkflowMetadata extends Readonly<Record<string, unknown>> {
  readonly artifactVersion: string;
  readonly source?: GitHubRunSource;
  readonly trigger?: "webhook" | "cron";
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
    !["artifactVersion", "artifactVersion,source", "artifactVersion,trigger"].includes(
      Object.keys(value).sort().join(","),
    )
  ) {
    throw new Error("invalid workflow metadata");
  }
  const { artifactVersion, source, trigger } = value as Record<string, unknown>;
  if (typeof artifactVersion !== "string" || !/^[0-9a-f]{64}$/.test(artifactVersion)) {
    throw new Error("invalid workflow metadata");
  }
  if (trigger === "webhook" || trigger === "cron") return { artifactVersion, trigger };
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
  const object = await env[DATA_BUCKET_BINDING].get(workflowArtifactKey(metadata.artifactVersion));
  if (!object) throw new Error("missing workflow artifact");
  const bytes = await object.arrayBuffer();
  if ((await sha256(bytes)) !== metadata.artifactVersion) {
    throw new Error("invalid workflow artifact hash");
  }
  const artifact = decodeWorkflowArtifact(bytes);
  if (artifact.deploymentName !== config.deploymentName)
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
  const cacheRepositoryId = metadata.source
    ? `github:${metadata.source.check.repository.id}`
    : repositoryId;
  const admission = metadata.source
    ? metadata.source.admission.type === "push"
      ? {
          type: "push",
          ref: metadata.source.admission.ref,
          defaultRef: metadata.source.admission.defaultRef,
        }
      : {
          type: "pull_request",
          number: metadata.source.admission.number,
          headRepositoryId: `github:${metadata.source.repository.id}`,
          defaultRef: metadata.source.admission.defaultRef,
        }
    : { type: metadata.trigger ?? "webhook" };
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
          snapshotScope: `${config.deploymentName}:${artifact.workflowId}:${metadata.artifactVersion}`,
          terminal: {
            accountId: config.accountId,
            repositoryId,
            workflowId: artifact.workflowId,
            trustId: repositoryId,
            generation: metadata.source?.generation ?? 1,
          },
          cache: {
            accountId: config.accountId,
            admission,
            bucket: config.cacheBucket,
            imageDigest: config.imageDigest,
            repositoryId: cacheRepositoryId,
            workflowId: artifact.workflowId,
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
  const loaded = await readArtifact(
    env,
    { artifactVersion: route.artifactVersion, trigger: route.type },
    config,
  );
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
      const object = await env[DATA_BUCKET_BINDING].get(workflowCacheKey(cache[1]!));
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
      const result = (await coordinator.admit({
        accountId: config.accountId,
        delivery,
        workflows,
      })) as {
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
