import {
  createDynamicWorkflowEntrypoint,
  wrapWorkflowBinding,
  type WorkflowRunner,
} from "@cloudflare/dynamic-workflows";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";

import { createRunnerAdapter } from "./runner-adapter.ts";
import { SANDBOX_BINDING } from "./runner-config.ts";
import type { HostCapability } from "./runner.ts";
import { createSecretSnapshots } from "./secret-snapshot.ts";
import type { ExecResult } from "./types.ts";
import {
  ARTIFACT_BUCKET_BINDING,
  COMPATIBILITY_DATE,
  HOST_CAPABILITY_BINDING,
  isSecretSnapshotKeyBinding,
  LOADER_BINDING,
  RUNWAY_WORKFLOW_CLASS,
  SECRET_SNAPSHOT_KEY_BINDING,
  WORKFLOW_BINDING,
} from "./worker-contract.ts";
import { decodeWorkflowArtifact, workflowArtifactKey } from "./workflow-artifact.ts";
import type { WorkflowArtifact } from "./workflow-artifact.ts";

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
}

interface HostProps {
  readonly secretNames: ReadonlyArray<string>;
  readonly secretSnapshotKey: string;
  readonly snapshotScope: string;
}

interface LoaderContext {
  exports: {
    RunwayRunnerBinding(options: { props: HostProps }): HostCapability;
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
    };

export interface HostConfig {
  readonly scriptName: string;
  readonly deploymentId: string;
  readonly secretSnapshotKey: string;
  readonly routes: ReadonlyArray<HostRoute>;
}

export class RunwayRunnerBinding
  extends WorkerEntrypoint<HostEnv, HostProps>
  implements HostCapability
{
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

  #adapter(): ReturnType<typeof createRunnerAdapter> {
    return createRunnerAdapter({
      sandbox: (runnerId) =>
        getSandbox(this.env[SANDBOX_BINDING], runnerId, { enableDefaultSession: false }),
      status: async (runId) => await (await this.env[WORKFLOW_BINDING].get(runId)).status(),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
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

  async exec(
    request: Omit<Parameters<ReturnType<typeof createRunnerAdapter>["exec"]>[0], "secrets"> & {
      secrets: Readonly<Record<string, string>>;
    },
  ): Promise<ExecResult> {
    const { secrets, ...runnerRequest } = request;
    return await this.#adapter().exec({
      ...runnerRequest,
      secrets: this.#snapshotValues(secrets),
    });
  }

  async destroy(runId: string, secrets: Readonly<Record<string, string>>): Promise<void> {
    await this.#adapter().destroy(runId, this.#snapshotValues(secrets));
  }
}

interface WorkflowMetadata extends Readonly<Record<string, unknown>> {
  readonly artifactVersion: string;
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
    Object.keys(value).join(",") !== "artifactVersion"
  ) {
    throw new Error("invalid workflow metadata");
  }
  const { artifactVersion } = value as Record<string, unknown>;
  if (typeof artifactVersion !== "string" || !/^[0-9a-f]{64}$/.test(artifactVersion)) {
    throw new Error("invalid workflow metadata");
  }
  return { artifactVersion };
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
  const identity = new TextEncoder().encode(
    JSON.stringify([purpose, metadata.artifactVersion, config.deploymentId]),
  );
  const loaderId = await sha256(identity);
  return env[LOADER_BINDING].get(loaderId, async () => ({
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "index.js",
    modules: { "index.js": artifact.source },
    env: {
      [HOST_CAPABILITY_BINDING]: ctx.exports.RunwayRunnerBinding({
        props: {
          secretNames: artifact.secrets,
          secretSnapshotKey: config.secretSnapshotKey,
          snapshotScope: `${config.scriptName}:${artifact.workflowId}:${metadata.artifactVersion}`,
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
    return worker.getEntrypoint(RUNWAY_WORKFLOW_CLASS) as unknown as WorkflowRunner;
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
    if (req.method === "GET" && new URL(req.url).pathname === "/.runway/version") {
      return Response.json(
        { deploymentId: config.deploymentId },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const pathname = new URL(req.url).pathname;
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
