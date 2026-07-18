import { createHash } from "node:crypto";

import { toFile } from "cloudflare";

import { collectResultItems, resultOf, type CloudflareApi } from "../cloudflare.ts";
import type { PreparedDeployment } from "../deploy/artifacts.ts";
import type { Registry } from "../deploy/registry.ts";
import { workflowArtifactKey } from "../runtime/artifact.ts";
import {
  DATA_BUCKET_BINDING,
  CACHE_SECRET_BINDINGS,
  COMPATIBILITY_DATE,
  DYNAMIC_WORKFLOW_CLASS,
  GITHUB_SECRET_BINDINGS,
  isSecretSnapshotKeyBinding,
  LOADER_BINDING,
  SECRET_SNAPSHOT_KEY_BINDING,
  WORKFLOW_BINDING,
} from "../runtime/contract.ts";
import {
  SANDBOX_RUNNER_ABI,
  GITHUB_COORDINATOR_BINDING,
  GITHUB_COORDINATOR_CLASS,
  SANDBOX_APPLICATION,
  SANDBOX_BINDING,
  SANDBOX_CLASS,
  SANDBOX_CONTAINER,
  SANDBOX_IMAGE_DIGEST,
} from "../sandbox/config.ts";
import {
  stackIdOf,
  type StackControl,
  type StackBucket,
  type StackManifest,
  type StackReceipt,
  type StackResource,
} from "./stack.ts";

export interface CloudflareStackOptions {
  readonly cf: CloudflareApi;
  readonly accountId: string;
  readonly registry: Registry;
  readonly deployment: PreparedDeployment;
  readonly secretBindings: Readonly<Record<string, string>>;
  readonly stateBucket: string;
  readonly ready: (opts: {
    readonly host: string;
    readonly scriptName: string;
    readonly deploymentId: string;
  }) => Promise<void>;
}

interface StateObject {
  readonly key: string;
  readonly etag: string;
  readonly version?: string;
}

const status = (error: unknown, expected: number): boolean =>
  !!error && typeof error === "object" && "status" in error && error.status === expected;

const required = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`invalid Cloudflare ${field}`);
  return value;
};

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const matchesInstanceType = (
  configuration: Record<string, unknown> | undefined,
  instanceType: string,
): boolean => {
  if (configuration?.instance_type === instanceType) return true;
  const disk = configuration?.disk as { size_mb?: unknown } | undefined;
  return (
    instanceType === "standard-4" &&
    configuration?.vcpu === 4 &&
    configuration?.memory_mib === 12_288 &&
    disk?.size_mb === 20_000
  );
};

interface ProviderZone {
  readonly id: string;
  readonly name: string;
}

interface ProviderRoute {
  readonly zoneId: string;
  readonly id: string;
  readonly pattern: string;
  readonly script?: string;
}

const routeHostname = (pattern: string): string => {
  const authority = pattern.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/", 1)[0]!;
  return authority
    .replace(/^\*\.?/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
};

export const validateBindings = (secrets: readonly string[]): void => {
  const names = new Map<string, string>([
    [WORKFLOW_BINDING, "Runway workflow binding"],
    [LOADER_BINDING, "Runway worker loader binding"],
    [DATA_BUCKET_BINDING, "Runway workflow artifact binding"],
    [SANDBOX_BINDING, "Runway sandbox binding"],
    [GITHUB_COORDINATOR_BINDING, "Runway GitHub coordinator binding"],
    ...GITHUB_SECRET_BINDINGS.map((name) => [name, "Runway GitHub App binding"] as const),
    ...CACHE_SECRET_BINDINGS.map((name) => [name, "Runway cache transport binding"] as const),
  ]);
  for (const secret of secrets) {
    if (isSecretSnapshotKeyBinding(secret)) {
      throw new Error(`binding ${JSON.stringify(secret)} is used by Runway and a secret`);
    }
    const owner = names.get(secret);
    if (owner) {
      throw new Error(`binding ${JSON.stringify(secret)} is used by ${owner} and a secret`);
    }
  }
};

export const cloudflareStackManifest = (opts: {
  readonly accountId: string;
  readonly repositoryId: string;
  readonly name: string;
  readonly deployment: PreparedDeployment;
  readonly schedules: readonly string[];
  readonly secretNames: readonly string[];
  readonly snapshotKeyBindings: readonly string[];
  readonly dataBucket: string;
  readonly stateBucket: string;
}): StackManifest => {
  const imageDigest = SANDBOX_IMAGE_DIGEST;
  const moduleDigest = `sha256:${sha256(opts.deployment.host)}`;
  const artifacts = opts.deployment.artifacts
    .map(({ artifactVersion }) => ({
      key: `artifacts/${artifactVersion}.json`,
      shared: true,
      digest: `sha256:${artifactVersion}`,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const generation = `sha256:${sha256(
    JSON.stringify({
      moduleDigest,
      artifacts,
      schedules: opts.schedules,
      secretNames: opts.secretNames,
      snapshotKeyBindings: opts.snapshotKeyBindings,
      image: SANDBOX_CONTAINER.image,
      instanceType: SANDBOX_CONTAINER.instance_type,
    }),
  )}`;
  const bindings = [
    { name: LOADER_BINDING, type: "worker_loader" },
    { name: DATA_BUCKET_BINDING, type: "r2_bucket", target: opts.dataBucket },
    {
      name: GITHUB_COORDINATOR_BINDING,
      type: "durable_object_namespace",
      target: GITHUB_COORDINATOR_CLASS,
    },
    { name: SANDBOX_BINDING, type: "durable_object_namespace", target: SANDBOX_CLASS },
    { name: WORKFLOW_BINDING, type: "workflow", target: opts.name },
  ].sort((left, right) => left.name.localeCompare(right.name));
  return {
    owner: {
      accountId: opts.accountId,
      repositoryId: opts.repositoryId,
      stackId: stackIdOf(opts.accountId, opts.repositoryId, opts.name),
      name: opts.name,
    },
    generation,
    worker: { name: opts.name, moduleDigest },
    workflow: { name: opts.name, className: DYNAMIC_WORKFLOW_CLASS },
    container: {
      name: opts.name,
      image: SANDBOX_CONTAINER.image,
      imageDigest,
      platform: { os: "linux", architecture: "amd64" },
      runnerAbi: SANDBOX_RUNNER_ABI,
      instanceType: SANDBOX_CONTAINER.instance_type,
      schedulingPolicy: SANDBOX_APPLICATION.scheduling_policy,
      maxInstances: SANDBOX_APPLICATION.max_instances,
      tiers: SANDBOX_APPLICATION.constraints.tiers.map(String),
      rolloutActiveGracePeriod: SANDBOX_APPLICATION.rollout_active_grace_period,
    },
    namespaces: [
      {
        binding: GITHUB_COORDINATOR_BINDING,
        className: GITHUB_COORDINATOR_CLASS,
        name: `${opts.name}_${GITHUB_COORDINATOR_CLASS}`,
      },
      { binding: SANDBOX_BINDING, className: SANDBOX_CLASS, name: `${opts.name}_${SANDBOX_CLASS}` },
    ].sort((left, right) => left.binding.localeCompare(right.binding)),
    schedules: [...opts.schedules].sort(),
    workersDev: true,
    routes: [],
    bindings,
    secretNames: [...opts.secretNames].sort(),
    secretSnapshot: {
      binding: SECRET_SNAPSHOT_KEY_BINDING,
      ownedKeyBindings: [...opts.snapshotKeyBindings].sort(),
    },
    buckets: [
      {
        name: opts.dataBucket,
        shared: true,
        lifecycle: "retain",
        publicAccess: false,
        customDomains: [],
        objects: artifacts,
      },
      {
        name: opts.stateBucket,
        shared: true,
        lifecycle: "stack-state",
        publicAccess: false,
        customDomains: [],
        objects: [],
      },
    ].sort((left, right) => left.name.localeCompare(right.name)),
  };
};

const deploymentOf = (value: unknown): { id: string; versionId: string } => {
  const result = resultOf(value) as { deployments?: readonly unknown[] } | undefined;
  const deployments =
    result?.deployments ?? (value as { deployments?: readonly unknown[] })?.deployments;
  const current = deployments?.[0] as
    | { id?: unknown; versions?: readonly { version_id?: unknown; percentage?: unknown }[] }
    | undefined;
  const version = current?.versions?.find(({ percentage }) => percentage === 100);
  return {
    id: required(current?.id, "Worker deployment"),
    versionId: required(version?.version_id, "Worker deployment version"),
  };
};

const bindingsOf = (
  version: unknown,
): readonly {
  name: string;
  type: string;
  target?: string;
  namespaceId?: string;
}[] => {
  const result = resultOf(version) as
    | { resources?: { bindings?: readonly Record<string, unknown>[] } }
    | undefined;
  return (result?.resources?.bindings ?? [])
    .filter(({ type }) => type !== "secret_text")
    .map((binding) => ({
      name: required(binding.name, "Worker binding name"),
      type: required(binding.type, "Worker binding type"),
      ...(typeof binding.bucket_name === "string"
        ? { target: binding.bucket_name }
        : typeof binding.workflow_name === "string"
          ? { target: binding.workflow_name }
          : typeof binding.class_name === "string"
            ? { target: binding.class_name }
            : {}),
      ...(typeof binding.namespace_id === "string" ? { namespaceId: binding.namespace_id } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
};

const textOf = async (value: unknown): Promise<string> => {
  const result = resultOf(value);
  if (result instanceof Response) return await result.text();
  if (result && typeof result === "object" && "text" in result) {
    return await (result as { text(): Promise<string> }).text();
  }
  if (typeof result === "string") return result;
  if (result instanceof Uint8Array) return new TextDecoder().decode(result);
  throw new Error("invalid Cloudflare Stack state object");
};

const bytesOf = async (value: unknown): Promise<Uint8Array> => {
  const result = resultOf(value);
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof Response) return new Uint8Array(await result.arrayBuffer());
  if (typeof result === "string") return new TextEncoder().encode(result);
  if (result && typeof result === "object" && "arrayBuffer" in result) {
    return new Uint8Array(await (result as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
  }
  throw new Error("invalid Cloudflare R2 object body");
};

export class CloudflareStackControl implements StackControl {
  readonly #opts: CloudflareStackOptions;
  #stateReady = false;
  #urls: readonly { readonly id: string; readonly url: string }[] = [];

  constructor(opts: CloudflareStackOptions) {
    this.#opts = opts;
  }

  urls(): readonly { readonly id: string; readonly url: string }[] {
    return this.#urls;
  }

  async apply(manifest: StackManifest): Promise<void> {
    if (manifest.owner.accountId !== this.#opts.accountId)
      throw new Error("Stack account mismatch");
    const workflows = await collectResultItems(
      await this.#opts.cf.workflows.list({ account_id: this.#opts.accountId }),
      (item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : undefined),
    );
    const workflowCollision = workflows.find(
      ({ name, script_name: scriptName }) =>
        name === manifest.workflow.name && scriptName !== manifest.worker.name,
    );
    if (workflowCollision) {
      const collisionOwner =
        typeof workflowCollision.script_name === "string"
          ? workflowCollision.script_name
          : "<unknown>";
      throw new Error(
        `Dynamic Workflow ${manifest.workflow.name} already belongs to Worker ${collisionOwner}`,
      );
    }
    await this.#assertRouteOwnership(manifest);
    const scripts = await collectResultItems(
      await this.#opts.cf.workers.scripts.list({ account_id: this.#opts.accountId }),
      (item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : undefined),
    );
    const workerExists = scripts.some(({ id }) => id === manifest.worker.name);

    const dataBucket = manifest.buckets.find(({ lifecycle }) => lifecycle === "retain");
    if (!dataBucket) throw new Error("Stack has no data bucket");
    try {
      try {
        await this.#opts.cf.r2.buckets.get(dataBucket.name, {
          account_id: this.#opts.accountId,
        });
      } catch (error) {
        if (!status(error, 404)) throw error;
        await this.#opts.cf.r2.buckets.create({
          account_id: this.#opts.accountId,
          name: dataBucket.name,
        });
      }
      for (const artifact of this.#opts.deployment.artifacts) {
        await this.#persistArtifact(dataBucket, artifact);
      }
    } catch (error) {
      if (!status(error, 403)) throw error;
      throw new Error(
        "Cloudflare API token needs Workers R2 Storage Write permission to persist Runway workflow artifacts",
        { cause: error },
      );
    }

    const metadata = {
      main_module: "worker.js",
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: ["nodejs_compat"],
      keep_bindings: ["secret_text"],
      annotations: {
        "workers/tag": manifest.worker.moduleDigest,
        "workers/message": manifest.generation,
      },
      bindings: [
        { type: "worker_loader" as const, name: LOADER_BINDING },
        {
          type: "r2_bucket" as const,
          name: DATA_BUCKET_BINDING,
          bucket_name: dataBucket.name,
        },
        {
          type: "workflow" as const,
          name: WORKFLOW_BINDING,
          workflow_name: manifest.workflow.name,
          class_name: manifest.workflow.className,
        },
        ...manifest.namespaces.map(({ binding, className }) => ({
          type: "durable_object_namespace" as const,
          name: binding,
          class_name: className,
        })),
        ...Object.entries(this.#opts.secretBindings).map(([name, text]) => ({
          type: "secret_text" as const,
          name,
          text,
        })),
      ],
      containers: [{ class_name: SANDBOX_CLASS }],
      ...(workerExists
        ? {}
        : {
            migrations: {
              new_tag: "runway-v1",
              new_sqlite_classes: manifest.namespaces
                .map(({ className }) => className)
                .sort((left, right) => left.localeCompare(right)),
            },
          }),
    } as Parameters<CloudflareApi["workers"]["scripts"]["update"]>[1]["metadata"];
    await this.#opts.cf.workers.scripts.update(manifest.worker.name, {
      account_id: this.#opts.accountId,
      metadata,
      files: [
        await toFile(this.#opts.deployment.host, "worker.js", {
          type: "application/javascript+module",
        }),
      ],
    });

    await this.#reconcileContainer(manifest);
    await this.#opts.cf.workflows.update(manifest.workflow.name, {
      account_id: this.#opts.accountId,
      class_name: manifest.workflow.className,
      script_name: manifest.worker.name,
    });
    await this.#opts.cf.workers.scripts.schedules.update(manifest.worker.name, {
      account_id: this.#opts.accountId,
      body: manifest.schedules.map((cron) => ({ cron })),
    });
    await this.#opts.cf.workers.scripts.subdomain.create(manifest.worker.name, {
      account_id: this.#opts.accountId,
      enabled: manifest.workersDev,
    });
    await this.#reconcileRoutes(manifest);
    const account = resultOf(
      await this.#opts.cf.workers.subdomains.get({ account_id: this.#opts.accountId }),
    ) as { subdomain?: unknown } | undefined;
    const subdomain = required(account?.subdomain, "workers.dev subdomain");
    const host = `${manifest.worker.name}.${subdomain}.workers.dev`;
    this.#urls = [
      ...this.#opts.registry.flatMap((item) =>
        item.def.trigger.type === "webhook"
          ? [{ id: item.def.id, url: `https://${host}${item.def.trigger.path}` }]
          : [],
      ),
      ...(this.#opts.registry.some(({ def }) => def.trigger.type === "github")
        ? [{ id: "github", url: `https://${host}/.runway/github` }]
        : []),
    ];
    await this.#opts.ready({
      host,
      scriptName: manifest.worker.name,
      deploymentId: this.#opts.deployment.deploymentId,
    });
  }

  async inventory(manifest: StackManifest): Promise<StackReceipt> {
    const scripts = await collectResultItems(
      await this.#opts.cf.workers.scripts.list({ account_id: this.#opts.accountId }),
      (item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : undefined),
    );
    const script = scripts.find(({ id }) => id === manifest.worker.name);
    if (!script) throw new Error("missing exact Cloudflare Worker");
    const deployment = deploymentOf(
      await this.#opts.cf.workers.scripts.deployments.list(manifest.worker.name, {
        account_id: this.#opts.accountId,
      }),
    );
    const version = await this.#opts.cf.workers.scripts.versions.get(
      manifest.worker.name,
      deployment.versionId,
      { account_id: this.#opts.accountId },
    );
    const versionResult = resultOf(version) as
      | {
          resources?: { script?: { etag?: unknown } };
        }
      | undefined;
    const settings = resultOf(
      await this.#opts.cf.workers.scripts.scriptAndVersionSettings.get(manifest.worker.name, {
        account_id: this.#opts.accountId,
      }),
    ) as
      | {
          annotations?: { "workers/tag"?: unknown; "workers/message"?: unknown };
        }
      | undefined;
    if (
      settings?.annotations?.["workers/tag"] !== manifest.worker.moduleDigest ||
      settings.annotations["workers/message"] !== manifest.generation
    ) {
      throw new Error("Cloudflare Worker module identity does not match Stack manifest");
    }
    const moduleDigest = required(settings.annotations["workers/tag"], "Worker module digest");
    const generation = required(settings.annotations["workers/message"], "Stack generation");
    const providerEtag = required(versionResult?.resources?.script?.etag, "Worker module etag");
    const bindings = bindingsOf(version);
    const observedBindings = bindings.map(({ namespaceId: _namespaceId, ...binding }) => binding);
    const manifestBindings = manifest.bindings.map(({ name, type, target }) => ({
      name,
      type,
      ...(target ? { target } : {}),
    }));
    if (JSON.stringify(observedBindings) !== JSON.stringify(manifestBindings)) {
      throw new Error("Cloudflare Worker bindings do not match Stack manifest");
    }
    const workflows = await collectResultItems(
      await this.#opts.cf.workflows.list({ account_id: this.#opts.accountId }),
      (item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : undefined),
    );
    const workflow = workflows.find(
      ({ name, script_name, class_name }) =>
        name === manifest.workflow.name &&
        script_name === manifest.worker.name &&
        class_name === manifest.workflow.className,
    );
    if (!workflow) throw new Error("missing exact Cloudflare Dynamic Workflow");
    const applications = resultOf(
      await this.#opts.cf.containers.applications.list({ account_id: this.#opts.accountId }),
    );
    const application = Array.isArray(applications)
      ? (applications.find(
          (item) =>
            item &&
            typeof item === "object" &&
            (item as { name?: unknown }).name === manifest.container.name,
        ) as Record<string, unknown> | undefined)
      : undefined;
    if (!application) throw new Error("missing exact Cloudflare container application");
    const applicationId = required(application.id, "container application id");
    const rolloutResult = resultOf(
      await this.#opts.cf.containers.rollouts.list(applicationId, {
        account_id: this.#opts.accountId,
      }),
    );
    const rollouts = Array.isArray(rolloutResult)
      ? rolloutResult
      : ((rolloutResult as { rollouts?: readonly unknown[] } | undefined)?.rollouts ?? []);
    const rollout = rollouts[0] as Record<string, unknown> | undefined;
    if (rollout && rollout.status !== "completed") {
      throw new Error("missing active completed Cloudflare container rollout");
    }
    const configuration = application.configuration as Record<string, unknown> | undefined;
    const constraints = application.constraints as { tiers?: unknown } | undefined;
    const durableObjects = application.durable_objects as { namespace_id?: unknown } | undefined;
    const sandboxBinding = bindings.find(({ name }) => name === SANDBOX_BINDING);
    if (
      configuration?.image !== manifest.container.image ||
      !matchesInstanceType(configuration, manifest.container.instanceType) ||
      application.max_instances !== manifest.container.maxInstances ||
      application.scheduling_policy !== manifest.container.schedulingPolicy ||
      application.rollout_active_grace_period !== manifest.container.rolloutActiveGracePeriod ||
      JSON.stringify(constraints?.tiers) !== JSON.stringify(manifest.container.tiers.map(Number)) ||
      durableObjects?.namespace_id !== sandboxBinding?.namespaceId
    ) {
      throw new Error("Cloudflare container does not match Stack manifest");
    }
    if (!Array.isArray(constraints?.tiers) || typeof application.max_instances !== "number") {
      throw new Error("invalid Cloudflare container capacity");
    }
    const containerImage = required(configuration.image, "container image");
    const providerRoutes = await this.#providerRoutes();
    const desiredRoutes = new Set(manifest.routes);
    for (const route of providerRoutes.routes.filter(({ pattern }) => desiredRoutes.has(pattern))) {
      if (route.script !== manifest.worker.name) {
        throw new Error(`Cloudflare route ${route.pattern} belongs to another Worker`);
      }
    }
    const routes = providerRoutes.routes
      .filter(({ script }) => script === manifest.worker.name)
      .map(({ zoneId, id, pattern, script }) => ({
        zoneId,
        id,
        pattern,
        scriptName: required(script, "Worker route script"),
      }))
      .sort((left, right) => left.pattern.localeCompare(right.pattern));
    if (JSON.stringify(routes.map(({ pattern }) => pattern)) !== JSON.stringify(manifest.routes)) {
      throw new Error("Cloudflare Worker routes do not match Stack manifest");
    }
    const schedulesResult = resultOf(
      await this.#opts.cf.workers.scripts.schedules.get(manifest.worker.name, {
        account_id: this.#opts.accountId,
      }),
    ) as { schedules?: readonly { cron?: unknown }[] } | undefined;
    const schedules = (schedulesResult?.schedules ?? [])
      .map(({ cron }) => required(cron, "Worker schedule"))
      .sort();
    const subdomain = resultOf(
      await this.#opts.cf.workers.scripts.subdomain.get(manifest.worker.name, {
        account_id: this.#opts.accountId,
      }),
    ) as { enabled?: unknown } | undefined;
    if (subdomain?.enabled !== manifest.workersDev) {
      throw new Error("Cloudflare workers.dev state does not match Stack manifest");
    }
    const workersDev = subdomain.enabled;
    const secretNames = [
      ...(await collectResultItems(
        await this.#opts.cf.workers.scripts.secrets.list(manifest.worker.name, {
          account_id: this.#opts.accountId,
        }),
        (item) =>
          item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
            ? (item as { name: string }).name
            : undefined,
      )),
    ].sort();
    const secretSnapshot = {
      binding: SECRET_SNAPSHOT_KEY_BINDING,
      ownedKeyBindings: secretNames.filter((name) =>
        name.startsWith(`${SECRET_SNAPSHOT_KEY_BINDING}_`),
      ),
    };
    if (JSON.stringify(secretSnapshot) !== JSON.stringify(manifest.secretSnapshot)) {
      throw new Error("Cloudflare secret snapshot ownership does not match Stack manifest");
    }
    const providerNamespaces = await collectResultItems(
      await this.#opts.cf.durableObjects.namespaces.list({
        account_id: this.#opts.accountId,
      }),
      (item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : undefined),
    );
    const namespaces = manifest.namespaces.map(({ binding, className, name }) => {
      const bound = bindings.find(
        (candidate) => candidate.name === binding && candidate.target === className,
      );
      const id = required(bound?.namespaceId, "Durable Object namespace id");
      const found = providerNamespaces.find((candidate) => candidate.id === id);
      if (
        !found ||
        found.name !== name ||
        found.class !== className ||
        found.script !== manifest.worker.name
      ) {
        throw new Error(`Cloudflare Durable Object namespace does not match Stack manifest`);
      }
      return {
        binding: required(bound?.name, "Durable Object binding name"),
        className: required(found.class, "Durable Object namespace class"),
        name: required(found.name, "Durable Object namespace name"),
        id,
        scriptName: required(found.script, "Durable Object namespace script"),
      };
    });
    const buckets = await Promise.all(
      manifest.buckets.map(async (bucket) => {
        await this.#opts.cf.r2.buckets.get(bucket.name, { account_id: this.#opts.accountId });
        const lifecycleResult = resultOf(
          await this.#opts.cf.r2.buckets.lifecycle.get(bucket.name, {
            account_id: this.#opts.accountId,
          }),
        ) as { rules?: readonly Record<string, unknown>[] } | undefined;
        const deletesObjects = (lifecycleResult?.rules ?? []).some(
          (rule) => rule.enabled === true && rule.deleteObjectsTransition !== undefined,
        );
        if (deletesObjects) {
          throw new Error(`Cloudflare R2 bucket lifecycle does not retain ${bucket.name}`);
        }
        const lifecycle = bucket.name === this.#opts.stateBucket ? "stack-state" : "retain";
        if (lifecycle !== bucket.lifecycle) {
          throw new Error(`Cloudflare R2 bucket lifecycle does not match Stack manifest`);
        }
        const managed = resultOf(
          await this.#opts.cf.r2.buckets.domains.managed.list(bucket.name, {
            account_id: this.#opts.accountId,
          }),
        ) as { enabled?: unknown } | undefined;
        if (typeof managed?.enabled !== "boolean") {
          throw new Error(`invalid Cloudflare R2 public access for ${bucket.name}`);
        }
        const publicAccess = managed.enabled;
        if (publicAccess !== bucket.publicAccess) {
          throw new Error(`Cloudflare R2 bucket public access does not match Stack manifest`);
        }
        const customResult = resultOf(
          await this.#opts.cf.r2.buckets.domains.custom.list(bucket.name, {
            account_id: this.#opts.accountId,
          }),
        ) as { domains?: readonly { domain?: unknown; enabled?: unknown }[] } | undefined;
        const customDomains = (customResult?.domains ?? [])
          .filter(({ enabled }) => enabled === true)
          .map(({ domain }) => required(domain, "R2 custom domain"))
          .sort();
        if (JSON.stringify(customDomains) !== JSON.stringify(bucket.customDomains)) {
          throw new Error(`Cloudflare R2 bucket custom domains do not match Stack manifest`);
        }
        const objects = await collectResultItems(
          await this.#opts.cf.r2.buckets.objects.list(bucket.name, {
            account_id: this.#opts.accountId,
          }),
          (item) =>
            item && typeof item === "object" ? (item as Record<string, unknown>) : undefined,
        );
        return {
          name: bucket.name,
          shared: bucket.shared,
          lifecycle,
          publicAccess,
          customDomains,
          objects: await Promise.all(
            bucket.objects.map(async (expected) => {
              const found = objects.find(({ key }) => key === expected.key);
              if (!found) throw new Error(`missing exact Cloudflare R2 object ${expected.key}`);
              const contents = await bytesOf(
                await this.#opts.cf.r2.buckets.objects.get(bucket.name, expected.key, {
                  account_id: this.#opts.accountId,
                }),
              );
              const digest = `sha256:${sha256(contents)}`;
              if (digest !== expected.digest) {
                throw new Error(`Cloudflare R2 object digest does not match ${expected.key}`);
              }
              return {
                key: expected.key,
                shared: expected.shared,
                digest,
                etag: required(found.etag, "R2 object etag"),
                ...(typeof found.version === "string" ? { version: found.version } : {}),
              };
            }),
          ),
        };
      }),
    );
    return {
      owner: manifest.owner,
      generation,
      worker: {
        name: required(script.id, "Worker name"),
        moduleDigest,
        providerEtag,
        versionId: deployment.versionId,
        deploymentId: deployment.id,
      },
      workflow: { ...manifest.workflow, id: required(workflow.id, "Dynamic Workflow id") },
      container: {
        name: required(application.name, "container application name"),
        image: containerImage,
        imageDigest: containerImage.slice(containerImage.indexOf("@") + 1),
        platform: { os: "linux", architecture: "amd64" },
        runnerAbi: SANDBOX_RUNNER_ABI,
        instanceType: manifest.container.instanceType,
        schedulingPolicy: required(application.scheduling_policy, "container scheduling policy"),
        maxInstances: application.max_instances,
        tiers: constraints.tiers.map(String),
        rolloutActiveGracePeriod: application.rollout_active_grace_period as number,
        id: applicationId,
        ...(rollout ? { rolloutId: required(rollout.id, "container rollout id") } : {}),
        namespaceId: required(durableObjects?.namespace_id, "container namespace id"),
      },
      namespaces,
      schedules,
      workersDev,
      bindings: observedBindings,
      secretNames,
      secretSnapshot,
      buckets,
      routes,
    };
  }

  async read(key: string): Promise<{ value: string; revision: string } | undefined> {
    const objects = await this.#stateObjects(key);
    if (objects.length === 0) return undefined;
    const values = await Promise.all(
      objects.map(async (object) => ({
        object,
        value: await textOf(
          await this.#opts.cf.r2.buckets.objects.get(this.#opts.stateBucket, object.key, {
            account_id: this.#opts.accountId,
          }),
        ),
      })),
    );
    const distinct = new Set(values.map(({ value }) => value));
    if (distinct.size !== 1) throw new Error("conflicting immutable Cloudflare Stack state");
    const winner = values[0]!;
    return { value: winner.value, revision: winner.object.key };
  }

  async list(prefix: string): Promise<readonly { key: string; value: string; revision: string }[]> {
    const objects = await this.#stateObjects(prefix);
    const logical = new Map<string, StateObject[]>();
    for (const object of objects) {
      const marker = object.key.lastIndexOf(".versions/");
      if (marker < 0) throw new Error("unknown Cloudflare Stack state object");
      const key = object.key.slice(0, marker);
      const values = logical.get(key) ?? [];
      values.push(object);
      logical.set(key, values);
    }
    return await Promise.all(
      [...logical.keys()].sort().map(async (key) => {
        const stored = await this.read(key);
        if (!stored) throw new Error("Cloudflare Stack state disappeared");
        return { key, ...stored };
      }),
    );
  }

  async writeOnce(key: string, value: string): Promise<void> {
    await this.#ensureStateBucket();
    const physical = `${key}.versions/${sha256(value)}.json`;
    await this.#opts.cf.r2.buckets.objects.upload(
      this.#opts.stateBucket,
      physical,
      new TextEncoder().encode(value),
      { account_id: this.#opts.accountId },
    );
    const stored = await this.read(key);
    if (!stored || stored.value !== value) throw new Error("Cloudflare Stack state write conflict");
  }

  async deleteState(_key: string, revision: string): Promise<void> {
    await this.#opts.cf.r2.buckets.objects.delete(this.#opts.stateBucket, revision, {
      account_id: this.#opts.accountId,
    });
  }

  async deleteResource(resource: StackResource): Promise<void> {
    switch (resource.type) {
      case "object": {
        if (!(await this.hasResource(resource))) return;
        await this.#opts.cf.r2.buckets.objects.delete(resource.bucket, resource.key, {
          account_id: this.#opts.accountId,
        });
        return;
      }
      case "bucket":
        if (!(await this.hasResource(resource))) return;
        await this.#opts.cf.r2.buckets.delete(resource.name, { account_id: this.#opts.accountId });
        return;
      case "container":
        if (!(await this.hasResource(resource))) return;
        await this.#opts.cf.containers.applications.delete(resource.id, {
          account_id: this.#opts.accountId,
        });
        return;
      case "namespace":
        if (await this.hasResource(resource)) {
          throw new Error("Cloudflare Durable Object namespace survived Worker force-delete");
        }
        return;
      case "workflow":
        if (await this.hasResource(resource)) {
          await this.#opts.cf.workflows.delete(resource.name, { account_id: this.#opts.accountId });
        }
        return;
      case "worker":
        if (!(await this.hasResource(resource))) return;
        await this.#opts.cf.workers.scripts.delete(resource.name, {
          account_id: this.#opts.accountId,
          force: true,
        });
        return;
      case "route": {
        if (!(await this.hasResource(resource))) return;
        await this.#opts.cf.workers.routes.delete(resource.id, { zone_id: resource.zoneId });
        return;
      }
    }
  }

  async hasResource(resource: StackResource): Promise<boolean> {
    try {
      switch (resource.type) {
        case "object": {
          const found = await this.#r2Object(resource.bucket, resource.key);
          if (!found) return false;
          const contents = await bytesOf(
            await this.#opts.cf.r2.buckets.objects.get(resource.bucket, resource.key, {
              account_id: this.#opts.accountId,
            }),
          );
          if (
            found.etag !== resource.etag ||
            `sha256:${sha256(contents)}` !== resource.digest ||
            found.version !== resource.version
          ) {
            throw new Error("Cloudflare R2 object deletion evidence changed");
          }
          return true;
        }
        case "bucket": {
          await this.#opts.cf.r2.buckets.get(resource.name, { account_id: this.#opts.accountId });
          const lifecycle = resultOf(
            await this.#opts.cf.r2.buckets.lifecycle.get(resource.name, {
              account_id: this.#opts.accountId,
            }),
          ) as { rules?: readonly Record<string, unknown>[] } | undefined;
          const deletesObjects = (lifecycle?.rules ?? []).some(
            (rule) => rule.enabled === true && rule.deleteObjectsTransition !== undefined,
          );
          const lifecycleName = resource.name === this.#opts.stateBucket ? "stack-state" : "retain";
          const managed = resultOf(
            await this.#opts.cf.r2.buckets.domains.managed.list(resource.name, {
              account_id: this.#opts.accountId,
            }),
          ) as { enabled?: unknown } | undefined;
          const custom = resultOf(
            await this.#opts.cf.r2.buckets.domains.custom.list(resource.name, {
              account_id: this.#opts.accountId,
            }),
          ) as { domains?: readonly { domain?: unknown; enabled?: unknown }[] } | undefined;
          const domains = (custom?.domains ?? [])
            .filter(({ enabled }) => enabled === true)
            .map(({ domain }) => required(domain, "R2 custom domain"))
            .sort();
          if (
            deletesObjects ||
            lifecycleName !== resource.lifecycle ||
            managed?.enabled !== resource.publicAccess ||
            JSON.stringify(domains) !== JSON.stringify(resource.customDomains)
          ) {
            throw new Error("Cloudflare R2 bucket deletion evidence changed");
          }
          return true;
        }
        case "container": {
          const result = resultOf(
            await this.#opts.cf.containers.applications.list({ account_id: this.#opts.accountId }),
          );
          const applications = Array.isArray(result)
            ? (result.filter((item) => item && typeof item === "object") as Record<
                string,
                unknown
              >[])
            : [];
          const application = applications.find(
            ({ id, name }) => id === resource.id || name === resource.name,
          );
          if (!application) return false;
          const rolloutsResult = resultOf(
            await this.#opts.cf.containers.rollouts.list(resource.id, {
              account_id: this.#opts.accountId,
            }),
          );
          const rollouts = Array.isArray(rolloutsResult)
            ? rolloutsResult
            : ((rolloutsResult as { rollouts?: readonly unknown[] } | undefined)?.rollouts ?? []);
          const rollout = rollouts[0] as Record<string, unknown> | undefined;
          const configuration = application.configuration as Record<string, unknown> | undefined;
          const constraints = application.constraints as { tiers?: unknown } | undefined;
          const durableObjects = application.durable_objects as
            | { namespace_id?: unknown }
            | undefined;
          if (
            application.id !== resource.id ||
            application.name !== resource.name ||
            configuration?.image !== resource.image ||
            !matchesInstanceType(configuration, resource.instanceType) ||
            application.scheduling_policy !== resource.schedulingPolicy ||
            application.max_instances !== resource.maxInstances ||
            JSON.stringify(constraints?.tiers) !== JSON.stringify(resource.tiers.map(Number)) ||
            application.rollout_active_grace_period !== resource.rolloutActiveGracePeriod ||
            durableObjects?.namespace_id !== resource.namespaceId ||
            rollout?.id !== resource.rolloutId ||
            (rollout !== undefined && rollout.status !== "completed") ||
            resource.image.slice(resource.image.indexOf("@") + 1) !== resource.imageDigest
          ) {
            throw new Error("Cloudflare container deletion evidence changed");
          }
          return true;
        }
        case "workflow": {
          const workflows = await collectResultItems(
            await this.#opts.cf.workflows.list({ account_id: this.#opts.accountId }),
            (item) =>
              item && typeof item === "object" ? (item as Record<string, unknown>) : undefined,
          );
          const workflow = workflows.find(
            ({ id, name }) => id === resource.id || name === resource.name,
          );
          if (!workflow) return false;
          if (
            workflow.id !== resource.id ||
            workflow.name !== resource.name ||
            workflow.class_name !== resource.className ||
            workflow.script_name !== resource.scriptName
          ) {
            throw new Error("Cloudflare Dynamic Workflow deletion evidence changed");
          }
          return true;
        }
        case "worker": {
          const workers = await collectResultItems(
            await this.#opts.cf.workers.scripts.list({ account_id: this.#opts.accountId }),
            (item) =>
              item && typeof item === "object" ? (item as Record<string, unknown>) : undefined,
          );
          if (!workers.some(({ id }) => id === resource.name)) return false;
          const deployment = deploymentOf(
            await this.#opts.cf.workers.scripts.deployments.list(resource.name, {
              account_id: this.#opts.accountId,
            }),
          );
          const version = resultOf(
            await this.#opts.cf.workers.scripts.versions.get(resource.name, deployment.versionId, {
              account_id: this.#opts.accountId,
            }),
          ) as { resources?: { script?: { etag?: unknown } } } | undefined;
          const settings = resultOf(
            await this.#opts.cf.workers.scripts.scriptAndVersionSettings.get(resource.name, {
              account_id: this.#opts.accountId,
            }),
          ) as { annotations?: { "workers/tag"?: unknown } } | undefined;
          if (
            deployment.id !== resource.deploymentId ||
            deployment.versionId !== resource.versionId ||
            version?.resources?.script?.etag !== resource.providerEtag ||
            settings?.annotations?.["workers/tag"] !== resource.moduleDigest
          ) {
            throw new Error("Cloudflare Worker deletion evidence changed");
          }
          return true;
        }
        case "namespace": {
          const namespaces = await collectResultItems(
            await this.#opts.cf.durableObjects.namespaces.list({
              account_id: this.#opts.accountId,
            }),
            (item) =>
              item && typeof item === "object" ? (item as Record<string, unknown>) : undefined,
          );
          const namespace = namespaces.find(
            ({ id, name }) => id === resource.id || name === resource.name,
          );
          if (!namespace) return false;
          if (
            namespace.id !== resource.id ||
            namespace.name !== resource.name ||
            namespace.class !== resource.className ||
            namespace.script !== resource.scriptName
          ) {
            throw new Error("Cloudflare Durable Object namespace deletion evidence changed");
          }
          return true;
        }
        case "route": {
          const route = resultOf(
            await this.#opts.cf.workers.routes.get(resource.id, { zone_id: resource.zoneId }),
          ) as { id?: unknown; pattern?: unknown; script?: unknown } | undefined;
          if (!route) return false;
          if (
            route.id !== resource.id ||
            route.pattern !== resource.pattern ||
            route.script !== resource.scriptName
          ) {
            throw new Error("Cloudflare route deletion evidence changed");
          }
          return true;
        }
      }
    } catch (error) {
      if (status(error, 404)) return false;
      throw error;
    }
  }

  async #readArtifact(bucket: string, key: string): Promise<Uint8Array | undefined> {
    try {
      return await bytesOf(
        await this.#opts.cf.r2.buckets.objects.get(bucket, key, {
          account_id: this.#opts.accountId,
        }),
      );
    } catch (error) {
      if (status(error, 404)) return undefined;
      throw error;
    }
  }

  #verifyArtifact(
    bucket: StackBucket,
    artifact: PreparedDeployment["artifacts"][number],
    contents: Uint8Array,
  ): void {
    const key = workflowArtifactKey(artifact.artifactVersion);
    const declared = bucket.objects.find((object) => object.key === key);
    const digest = `sha256:${sha256(artifact.contents)}`;
    if (!declared || !declared.shared || declared.digest !== digest) {
      throw new Error(`workflow artifact ${key} does not match Stack manifest`);
    }
    if (
      `sha256:${sha256(contents)}` !== declared.digest ||
      !equalBytes(contents, artifact.contents)
    ) {
      throw new Error(`Cloudflare R2 object conflicts with workflow artifact ${key}`);
    }
  }

  async #persistArtifact(
    bucket: StackBucket,
    artifact: PreparedDeployment["artifacts"][number],
  ): Promise<void> {
    const key = workflowArtifactKey(artifact.artifactVersion);
    const existing = await this.#readArtifact(bucket.name, key);
    if (existing) {
      this.#verifyArtifact(bucket, artifact, existing);
      return;
    }
    let uploadError: unknown;
    try {
      await this.#opts.cf.r2.buckets.objects.upload(
        bucket.name,
        key,
        artifact.contents,
        {
          account_id: this.#opts.accountId,
        },
        { headers: { "If-None-Match": "*" } },
      );
    } catch (error) {
      uploadError = error;
    }
    const stored = await this.#readArtifact(bucket.name, key);
    if (!stored) {
      if (uploadError) throw uploadError;
      throw new Error(`workflow artifact ${key} disappeared after upload`);
    }
    this.#verifyArtifact(bucket, artifact, stored);
  }

  async #providerRoutes(): Promise<{
    readonly zones: readonly ProviderZone[];
    readonly routes: readonly ProviderRoute[];
  }> {
    const zones = await collectResultItems(
      await this.#opts.cf.zones.list({ account: { id: this.#opts.accountId }, per_page: 100 }),
      (item) => {
        if (!item || typeof item !== "object") return undefined;
        const zone = item as Record<string, unknown>;
        return {
          id: required(zone.id, "zone id"),
          name: required(zone.name, "zone name").toLowerCase(),
        };
      },
    );
    const routes = (
      await Promise.all(
        zones.map(
          async (zone) =>
            await collectResultItems(
              await this.#opts.cf.workers.routes.list({ zone_id: zone.id }),
              (item) => {
                if (!item || typeof item !== "object") return undefined;
                const route = item as Record<string, unknown>;
                return {
                  zoneId: zone.id,
                  id: required(route.id, "Worker route id"),
                  pattern: required(route.pattern, "Worker route pattern"),
                  ...(typeof route.script === "string" ? { script: route.script } : {}),
                };
              },
            ),
        ),
      )
    ).flat();
    return { zones, routes };
  }

  async #assertRouteOwnership(manifest: StackManifest): Promise<void> {
    const { routes } = await this.#providerRoutes();
    const desired = new Set(manifest.routes);
    const unexpected = routes.find(
      ({ script, pattern }) => script === manifest.worker.name && !desired.has(pattern),
    );
    if (unexpected) {
      throw new Error(`Cloudflare Worker has an unowned route ${unexpected.pattern}`);
    }
    for (const pattern of manifest.routes) {
      const matches = routes.filter((route) => route.pattern === pattern);
      if (matches.length > 1) throw new Error(`Cloudflare route ${pattern} is ambiguous`);
      if (matches[0] && matches[0].script !== manifest.worker.name) {
        throw new Error(`Cloudflare route ${pattern} belongs to another Worker`);
      }
    }
  }

  async #reconcileRoutes(manifest: StackManifest): Promise<void> {
    await this.#assertRouteOwnership(manifest);
    for (const pattern of manifest.routes) {
      let provider = await this.#providerRoutes();
      const existing = provider.routes.filter((route) => route.pattern === pattern);
      if (existing.length === 1 && existing[0]!.script === manifest.worker.name) continue;
      if (existing.length > 0)
        throw new Error(`Cloudflare route ${pattern} is not exclusively owned`);
      const hostname = routeHostname(pattern);
      const zones = provider.zones
        .filter(({ name }) => hostname === name || hostname.endsWith(`.${name}`))
        .sort((left, right) => right.name.length - left.name.length);
      const zone = zones[0];
      if (!zone || (zones[1] && zones[1].name.length === zone.name.length)) {
        throw new Error(`Cloudflare route ${pattern} does not resolve to one account zone`);
      }
      let createError: unknown;
      try {
        await this.#opts.cf.workers.routes.create({
          zone_id: zone.id,
          pattern,
          script: manifest.worker.name,
        });
      } catch (error) {
        createError = error;
      }
      provider = await this.#providerRoutes();
      const created = provider.routes.filter((route) => route.pattern === pattern);
      if (
        created.length === 1 &&
        created[0]!.zoneId === zone.id &&
        created[0]!.script === manifest.worker.name
      ) {
        continue;
      }
      if (createError) throw createError;
      throw new Error(`Cloudflare route ${pattern} was not created exactly`);
    }
  }

  async #reconcileContainer(manifest: StackManifest): Promise<void> {
    const versions = await collectResultItems(
      await this.#opts.cf.workers.scripts.versions.list(manifest.worker.name, {
        account_id: this.#opts.accountId,
        per_page: 1,
      }),
      (item) =>
        item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id
          : undefined,
    );
    const versionId = versions[0];
    if (!versionId) throw new Error(`missing Worker version after deploy: ${manifest.worker.name}`);
    const version = resultOf(
      await this.#opts.cf.workers.scripts.versions.get(manifest.worker.name, versionId, {
        account_id: this.#opts.accountId,
      }),
    );
    const sandbox = bindingsOf(version).find(
      ({ name, target }) => name === SANDBOX_BINDING && target === SANDBOX_CLASS,
    );
    const namespaceId = required(sandbox?.namespaceId, "sandbox Durable Object namespace id");
    const applicationsResult = resultOf(
      await this.#opts.cf.containers.applications.list({ account_id: this.#opts.accountId }),
    );
    const applications = Array.isArray(applicationsResult)
      ? (applicationsResult.filter((item) => item && typeof item === "object") as Record<
          string,
          unknown
        >[])
      : [];
    const existing = applications.find(({ name }) => name === manifest.container.name);
    const applicationBody = {
      scheduling_policy: manifest.container.schedulingPolicy,
      configuration: {
        image: manifest.container.image,
        instance_type: manifest.container.instanceType,
      },
      instances: SANDBOX_APPLICATION.instances,
      max_instances: manifest.container.maxInstances,
      constraints: { tiers: manifest.container.tiers.map(Number) },
      rollout_active_grace_period: manifest.container.rolloutActiveGracePeriod,
    };
    if (!existing) {
      await this.#opts.cf.containers.applications.create({
        account_id: this.#opts.accountId,
        body: {
          name: manifest.container.name,
          ...applicationBody,
          durable_objects: { namespace_id: namespaceId },
        },
      });
      return;
    }
    const durableObjects = existing.durable_objects as { namespace_id?: unknown } | undefined;
    if (durableObjects?.namespace_id !== namespaceId) {
      throw new Error(
        `container application ${manifest.container.name} is attached to a different namespace`,
      );
    }
    const configuration = existing.configuration as Record<string, unknown> | undefined;
    const constraints = existing.constraints as { tiers?: unknown } | undefined;
    const exact =
      existing.scheduling_policy === applicationBody.scheduling_policy &&
      existing.max_instances === applicationBody.max_instances &&
      configuration?.image === applicationBody.configuration.image &&
      matchesInstanceType(configuration, applicationBody.configuration.instance_type) &&
      JSON.stringify(constraints?.tiers) === JSON.stringify(applicationBody.constraints.tiers) &&
      existing.rollout_active_grace_period === applicationBody.rollout_active_grace_period;
    if (exact) return;
    const applicationId = required(existing.id, "container application id");
    await this.#opts.cf.containers.applications.modify(applicationId, {
      account_id: this.#opts.accountId,
      body: applicationBody,
    });
    const rollout = resultOf(
      await this.#opts.cf.containers.rollouts.create(applicationId, {
        account_id: this.#opts.accountId,
        body: {
          description: "Runway deployment",
          strategy: "rolling",
          target_configuration: applicationBody.configuration,
          step_percentage: 25,
          kind: "full_auto",
        },
      }),
    ) as { id?: unknown } | undefined;
    const rolloutId = required(rollout?.id, "container rollout id");
    await this.#waitForContainerRollout(applicationId, rolloutId);
  }

  async #waitForContainerRollout(applicationId: string, rolloutId: string): Promise<void> {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const current = resultOf(
        await this.#opts.cf.containers.rollouts.get(applicationId, rolloutId, {
          account_id: this.#opts.accountId,
        }),
      ) as { status?: unknown } | undefined;
      if (current?.status === "completed") return;
      if (current?.status === "reverted" || current?.status === "replaced") {
        throw new Error(`container rollout ${current.status}`);
      }
      if (current?.status !== "pending" && current?.status !== "progressing") {
        throw new Error("invalid container rollout status");
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error("container rollout timed out");
  }

  async #ensureStateBucket(): Promise<void> {
    if (this.#stateReady) return;
    try {
      await this.#opts.cf.r2.buckets.get(this.#opts.stateBucket, {
        account_id: this.#opts.accountId,
      });
      await this.#stateObjects("");
    } catch (error) {
      if (!status(error, 404)) throw error;
      await this.#opts.cf.r2.buckets.create({
        account_id: this.#opts.accountId,
        name: this.#opts.stateBucket,
      });
    }
    await this.#assertPrivateRetainedStateBucket();
    this.#stateReady = true;
  }

  async #assertPrivateRetainedStateBucket(): Promise<void> {
    const params = { account_id: this.#opts.accountId };
    const lifecycle = resultOf(
      await this.#opts.cf.r2.buckets.lifecycle.get(this.#opts.stateBucket, params),
    ) as { rules?: readonly Record<string, unknown>[] } | undefined;
    const managed = resultOf(
      await this.#opts.cf.r2.buckets.domains.managed.list(this.#opts.stateBucket, params),
    ) as { enabled?: unknown } | undefined;
    const custom = resultOf(
      await this.#opts.cf.r2.buckets.domains.custom.list(this.#opts.stateBucket, params),
    ) as { domains?: readonly unknown[] } | undefined;
    if (
      (lifecycle?.rules ?? []).some(
        (rule) => rule.enabled === true && rule.deleteObjectsTransition !== undefined,
      ) ||
      managed?.enabled !== false ||
      (custom?.domains ?? []).length > 0
    ) {
      throw new Error("Cloudflare Stack state bucket configuration is not private and retained");
    }
  }

  async #stateObjects(prefix: string): Promise<readonly StateObject[]> {
    try {
      return await collectResultItems(
        await this.#opts.cf.r2.buckets.objects.list(this.#opts.stateBucket, {
          account_id: this.#opts.accountId,
          prefix,
        }),
        (item): StateObject | undefined => {
          if (!item || typeof item !== "object") return undefined;
          const object = item as { key?: unknown; etag?: unknown };
          if (typeof object.key !== "string" || typeof object.etag !== "string") return undefined;
          if (!object.key.startsWith("stack/v2/"))
            throw new Error("unknown Cloudflare Stack state object");
          return { key: object.key, etag: object.etag };
        },
      );
    } catch (error) {
      if (status(error, 404)) return [];
      throw error;
    }
  }

  async #r2Object(bucket: string, key: string): Promise<StateObject | undefined> {
    const objects = await collectResultItems(
      await this.#opts.cf.r2.buckets.objects.list(bucket, {
        account_id: this.#opts.accountId,
        prefix: key,
      }),
      (item): StateObject | undefined => {
        if (!item || typeof item !== "object") return undefined;
        const object = item as { key?: unknown; etag?: unknown; version?: unknown };
        return typeof object.key === "string" && typeof object.etag === "string"
          ? {
              key: object.key,
              etag: object.etag,
              ...(typeof object.version === "string" ? { version: object.version } : {}),
            }
          : undefined;
      },
    );
    return objects.find((object) => object.key === key);
  }
}
