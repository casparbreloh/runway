import { createHash } from "node:crypto";

import { collectResultItems, resultOf, type CloudflareApi } from "../cloudflare-api.ts";
import type { LegacyStackControl, LegacyStackReceipt } from "../legacy-stack.ts";
import { SECRET_SNAPSHOT_KEY_BINDING } from "../worker-contract.ts";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const indexMediaTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const manifestMediaTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const configMediaTypes = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);

const requiredDigest = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new Error(`invalid Docker Registry ${field}`);
  }
  return value;
};

const registryMediaType = (response: Response, body: Record<string, unknown>): string => {
  const header = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (!header || (!indexMediaTypes.has(header) && !manifestMediaTypes.has(header))) {
    throw new Error("invalid Docker Registry manifest media type");
  }
  if (body.mediaType !== undefined && body.mediaType !== header) {
    throw new Error("Docker Registry manifest media type changed");
  }
  return header;
};

const required = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid Cloudflare legacy ${field}`);
  }
  return value;
};

const number = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid Cloudflare legacy ${field}`);
  }
  return value;
};

const integer = (value: unknown, field: string): number => {
  const found = number(value, field);
  if (!Number.isSafeInteger(found)) throw new Error(`invalid Cloudflare legacy ${field}`);
  return found;
};

const record = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid Cloudflare legacy ${field}`);
  }
  return value as Record<string, unknown>;
};

const array = (value: unknown, field: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`invalid Cloudflare legacy ${field}`);
  return value;
};

const status = (error: unknown, expected: number): boolean =>
  !!error && typeof error === "object" && "status" in error && error.status === expected;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const textOf = async (value: unknown): Promise<string> => {
  const result = resultOf(value);
  if (result instanceof Response) return await result.text();
  if (typeof result === "string") return result;
  if (result instanceof Uint8Array) return new TextDecoder().decode(result);
  if (result && typeof result === "object" && "text" in result) {
    return await (result as { text(): Promise<string> }).text();
  }
  throw new Error("invalid Cloudflare legacy state object");
};

const lifecycleOf = (value: unknown): string => {
  const result = record(resultOf(value), "R2 lifecycle");
  const rules = array(result.rules, "R2 lifecycle rules");
  if (rules.length !== 1) throw new Error("unknown Cloudflare legacy R2 lifecycle rule");
  const rule = record(rules[0], "R2 lifecycle rule");
  const transition = record(rule.abortMultipartUploadsTransition, "R2 multipart abort transition");
  const condition = record(transition.condition, "R2 multipart abort condition");
  if (
    rule.id !== "Default Multipart Abort Rule" ||
    rule.enabled !== true ||
    condition.type !== "Age" ||
    condition.maxAge !== 604800 ||
    rule.deleteObjectsTransition !== undefined
  ) {
    throw new Error("unknown Cloudflare legacy R2 lifecycle rule");
  }
  return "default-multipart-abort-7-days";
};

const noCors = async (cf: CloudflareApi, bucket: string, accountId: string): Promise<boolean> => {
  try {
    await cf.r2.buckets.cors.get(bucket, { account_id: accountId });
    return true;
  } catch (error) {
    if (status(error, 404)) return false;
    throw error;
  }
};

export const resolveDockerImageDigest = async (
  imageTag: string,
  platform: LegacyStackReceipt["container"]["platform"],
  fetcher: typeof fetch = fetch,
): Promise<string> => {
  const match = /^docker\.io\/([^:@]+(?:\/[^:@]+)*):([^@]+)$/.exec(imageTag);
  if (!match) throw new Error("legacy image must be an exact tagged docker.io image");
  const [, repository, tag] = match;
  const tokenResponse = await fetcher(
    `https://auth.docker.io/token?service=registry.docker.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`,
  );
  if (!tokenResponse.ok) throw new Error(`Docker Registry token ${tokenResponse.status}`);
  const tokenValue = (await tokenResponse.json()) as { token?: unknown };
  if (typeof tokenValue.token !== "string" || tokenValue.token.length === 0) {
    throw new Error("invalid Docker Registry token");
  }
  const headers = {
    accept: [...indexMediaTypes, ...manifestMediaTypes].join(", "),
    authorization: `Bearer ${tokenValue.token}`,
  };
  const taggedResponse = await fetcher(
    `https://registry-1.docker.io/v2/${repository}/manifests/${tag}`,
    { headers },
  );
  if (!taggedResponse.ok) throw new Error(`Docker Registry manifest ${taggedResponse.status}`);
  const tagged = record(await taggedResponse.json(), "Docker Registry manifest");
  const taggedMediaType = registryMediaType(taggedResponse, tagged);

  const verifyManifest = async (
    response: Response,
    manifest: Record<string, unknown>,
    expectedDigest?: string,
  ): Promise<string> => {
    const mediaType = registryMediaType(response, manifest);
    if (!manifestMediaTypes.has(mediaType)) {
      throw new Error("invalid Docker Registry image manifest media type");
    }
    const observedDigest = requiredDigest(
      response.headers.get("docker-content-digest"),
      "content digest",
    );
    if (expectedDigest !== undefined && observedDigest !== expectedDigest) {
      throw new Error("Docker Registry platform digest changed");
    }
    const config = record(manifest.config, "Docker Registry config descriptor");
    if (typeof config.mediaType !== "string" || !configMediaTypes.has(config.mediaType)) {
      throw new Error("invalid Docker Registry config media type");
    }
    const configDigest = requiredDigest(config.digest, "config digest");
    const configResponse = await fetcher(
      `https://registry-1.docker.io/v2/${repository}/blobs/${configDigest}`,
      { headers: { authorization: headers.authorization } },
    );
    if (!configResponse.ok) throw new Error(`Docker Registry config ${configResponse.status}`);
    const configBody = record(await configResponse.json(), "Docker Registry config");
    if (configBody.os !== platform.os || configBody.architecture !== platform.architecture) {
      throw new Error("Docker Registry config platform changed");
    }
    return observedDigest;
  };

  if (manifestMediaTypes.has(taggedMediaType)) {
    return await verifyManifest(taggedResponse, tagged);
  }
  if (!indexMediaTypes.has(taggedMediaType)) {
    throw new Error("invalid Docker Registry index media type");
  }
  const matches = array(tagged.manifests, "Docker Registry index manifests")
    .map((item) => record(item, "Docker Registry index manifest"))
    .filter(({ platform: value }) => {
      const candidate = record(value, "Docker Registry index platform");
      return candidate.os === platform.os && candidate.architecture === platform.architecture;
    });
  if (matches.length !== 1) throw new Error("Docker Registry platform manifest is not unique");
  const descriptor = matches[0]!;
  if (typeof descriptor.mediaType !== "string" || !manifestMediaTypes.has(descriptor.mediaType)) {
    throw new Error("invalid Docker Registry platform manifest media type");
  }
  const digest = requiredDigest(descriptor.digest, "platform digest");
  const manifestResponse = await fetcher(
    `https://registry-1.docker.io/v2/${repository}/manifests/${digest}`,
    { headers },
  );
  if (!manifestResponse.ok)
    throw new Error(`Docker Registry platform manifest ${manifestResponse.status}`);
  const manifest = record(await manifestResponse.json(), "Docker Registry platform manifest");
  return await verifyManifest(manifestResponse, manifest, digest);
};

export interface CloudflareLegacyStackOptions {
  readonly cf: CloudflareApi;
  readonly accountId: string;
  readonly expected: LegacyStackReceipt;
  readonly stateBucket: string;
  readonly fetch?: typeof fetch;
}

export class CloudflareLegacyStackControl implements LegacyStackControl {
  readonly #opts: CloudflareLegacyStackOptions;
  readonly #key: string;

  constructor(opts: CloudflareLegacyStackOptions) {
    if (opts.expected.owner.accountId !== opts.accountId) {
      throw new Error("legacy Stack account mismatch");
    }
    this.#opts = opts;
    this.#key = `stack/v2/${opts.expected.owner.stackId}/legacy`;
  }

  async inventory(): Promise<LegacyStackReceipt> {
    const { accountId, cf, expected } = this.#opts;
    const scripts = await collectResultItems(
      await cf.workers.scripts.list({ account_id: accountId }),
      (item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : undefined),
    );
    const matchingScripts = scripts.filter(({ id }) => id === expected.worker.name);
    if (matchingScripts.length !== 1) throw new Error("missing exact legacy Worker");

    const versions = [
      ...(await collectResultItems(
        await cf.workers.scripts.versions.list(expected.worker.name, {
          account_id: accountId,
          per_page: 100,
        }),
        (item) =>
          item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
            ? (item as { id: string }).id
            : undefined,
      )),
    ].sort();
    const deploymentResponse = resultOf(
      await cf.workers.scripts.deployments.list(expected.worker.name, { account_id: accountId }),
    );
    const deployments = array(
      record(deploymentResponse, "Worker deployments").deployments,
      "Worker deployment history",
    ).map((item) => record(item, "Worker deployment"));
    const currentDeployment = deployments[0];
    if (!currentDeployment) throw new Error("missing legacy Worker deployment");
    const currentVersion = array(currentDeployment.versions, "Worker deployment versions").find(
      (item) => record(item, "Worker deployment version").percentage === 100,
    );
    const versionId = required(
      record(currentVersion, "Worker deployment version").version_id,
      "Worker version id",
    );
    const deploymentId = required(currentDeployment.id, "Worker deployment id");
    if (!versions.includes(versionId))
      throw new Error("legacy Worker deployment version is absent");
    const version = resultOf(
      await cf.workers.scripts.versions.get(expected.worker.name, versionId, {
        account_id: accountId,
      }),
    );
    const providerBindings = array(
      record(record(version, "Worker version").resources, "Worker resources").bindings,
      "Worker bindings",
    ).map((item) => record(item, "Worker binding"));
    const secretBindingNames = providerBindings
      .filter(({ type }) => type === "secret_text")
      .map(({ name }) => required(name, "secret binding name"))
      .sort();
    const bindings = providerBindings
      .filter(({ type }) => type !== "secret_text")
      .map((binding) => ({
        name: required(binding.name, "binding name"),
        type: required(binding.type, "binding type"),
        ...(typeof binding.bucket_name === "string"
          ? { target: binding.bucket_name }
          : typeof binding.workflow_name === "string"
            ? { target: binding.workflow_name }
            : typeof binding.class_name === "string"
              ? { target: binding.class_name }
              : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    const secrets = [
      ...(await collectResultItems(
        await cf.workers.scripts.secrets.list(expected.worker.name, { account_id: accountId }),
        (item) =>
          item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
            ? (item as { name: string }).name
            : undefined,
      )),
    ].sort();
    if (JSON.stringify(secrets) !== JSON.stringify(secretBindingNames)) {
      throw new Error("legacy Worker secret surfaces disagree");
    }

    const workflows = await collectResultItems(
      await cf.workflows.list({ account_id: accountId }),
      (item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : undefined),
    );
    const matchingWorkflows = workflows.filter(
      ({ name, script_name: scriptName }) =>
        name === expected.workflow.name || scriptName === expected.worker.name,
    );
    if (matchingWorkflows.length !== 1) throw new Error("missing exact legacy Workflow");
    const workflow = matchingWorkflows[0]!;
    const workflowVersions = await collectResultItems(
      await cf.workflows.versions.list(expected.workflow.name, { account_id: accountId }),
      (item) => {
        if (!item || typeof item !== "object") return undefined;
        const candidate = item as { id?: unknown; created_on?: unknown };
        return typeof candidate.id === "string" && typeof candidate.created_on === "string"
          ? { id: candidate.id, createdOn: candidate.created_on }
          : undefined;
      },
    );
    const orderedWorkflowVersions = [...workflowVersions].sort((left, right) =>
      right.createdOn.localeCompare(left.createdOn),
    );
    const workflowVersionId = required(orderedWorkflowVersions[0]?.id, "Workflow version id");

    const applicationsValue = resultOf(
      await cf.containers.applications.list({ account_id: accountId }),
    );
    const applications = array(applicationsValue, "container applications").map((item) =>
      record(item, "container application"),
    );
    const matchingApplications = applications.filter(
      ({ name }) => name === expected.container.name,
    );
    if (matchingApplications.length !== 1) throw new Error("missing exact legacy container");
    const application = matchingApplications[0]!;
    const applicationId = required(application.id, "container application id");
    const configuration = record(application.configuration, "container configuration");
    const disk = record(configuration.disk, "container disk");
    const network = record(configuration.network, "container network");
    const bandwidth = record(application.network, "container bandwidth");
    const constraints = record(application.constraints, "container constraints");
    const durableObjects = record(application.durable_objects, "container Durable Objects");
    const rolloutResult = resultOf(
      await cf.containers.rollouts.list(applicationId, { account_id: accountId }),
    );
    const rolloutItems = Array.isArray(rolloutResult)
      ? rolloutResult
      : array(record(rolloutResult, "container rollouts").rollouts, "container rollout history");
    const rollouts = rolloutItems
      .map((item) => {
        const rollout = record(item, "container rollout");
        return {
          id: required(rollout.id, "container rollout id"),
          status: required(rollout.status, "container rollout status"),
          currentVersion: integer(rollout.current_version, "container rollout current version"),
          targetVersion: integer(rollout.target_version, "container rollout target version"),
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    const applicationVersion = integer(application.version, "container version");
    const currentRollouts = rollouts.filter(
      ({ status: rolloutStatus, targetVersion }) =>
        rolloutStatus === "completed" && targetVersion === applicationVersion,
    );
    if (currentRollouts.length !== 1) throw new Error("legacy container rollout is not unique");

    const allNamespaces = await collectResultItems(
      await cf.durableObjects.namespaces.list({ account_id: accountId }),
      (item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : undefined),
    );
    const namespaceBindings = providerBindings.filter(
      ({ type }) => type === "durable_object_namespace",
    );
    const namespaces = allNamespaces
      .filter(({ script }) => script === expected.worker.name)
      .map((namespace) => {
        const id = required(namespace.id, "Durable Object namespace id");
        const bound = namespaceBindings.find(({ namespace_id: namespaceId }) => namespaceId === id);
        if (!bound) throw new Error("legacy Durable Object namespace is not bound");
        return {
          binding: required(bound.name, "Durable Object binding name"),
          name: required(namespace.name, "Durable Object namespace name"),
          className: required(namespace.class, "Durable Object namespace class"),
          id,
          scriptName: required(namespace.script, "Durable Object namespace script"),
        };
      })
      .sort((left, right) => left.binding.localeCompare(right.binding));

    const schedulesResult = resultOf(
      await cf.workers.scripts.schedules.get(expected.worker.name, { account_id: accountId }),
    );
    const schedules = array(
      record(schedulesResult, "Worker schedules").schedules,
      "Worker schedule list",
    )
      .map((item) => required(record(item, "Worker schedule").cron, "Worker schedule cron"))
      .sort();
    const subdomain = record(
      resultOf(
        await cf.workers.scripts.subdomain.get(expected.worker.name, { account_id: accountId }),
      ),
      "workers.dev state",
    );
    if (typeof subdomain.enabled !== "boolean" || typeof subdomain.previews_enabled !== "boolean") {
      throw new Error("invalid Cloudflare legacy workers.dev state");
    }

    const zones = await collectResultItems(
      await cf.zones.list({ account: { id: accountId }, per_page: 100 }),
      (item) =>
        item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id
          : undefined,
    );
    const routes = (
      await Promise.all(
        zones.map(
          async (zoneId) =>
            await collectResultItems(await cf.workers.routes.list({ zone_id: zoneId }), (item) => {
              if (!item || typeof item !== "object") return undefined;
              const route = item as { id?: unknown; pattern?: unknown; script?: unknown };
              return route.script === expected.worker.name
                ? {
                    zoneId,
                    id: required(route.id, "Worker route id"),
                    pattern: required(route.pattern, "Worker route pattern"),
                  }
                : undefined;
            }),
        ),
      )
    )
      .flat()
      .sort((left, right) => left.pattern.localeCompare(right.pattern));

    const buckets = await Promise.all(
      expected.buckets.map(async (expectedBucket) => {
        const info = record(
          resultOf(await cf.r2.buckets.get(expectedBucket.name, { account_id: accountId })),
          "R2 bucket",
        );
        const lifecycle = lifecycleOf(
          await cf.r2.buckets.lifecycle.get(expectedBucket.name, { account_id: accountId }),
        );
        const managed = record(
          resultOf(
            await cf.r2.buckets.domains.managed.list(expectedBucket.name, {
              account_id: accountId,
            }),
          ),
          "R2 managed domain",
        );
        const custom = record(
          resultOf(
            await cf.r2.buckets.domains.custom.list(expectedBucket.name, {
              account_id: accountId,
            }),
          ),
          "R2 custom domains",
        );
        const customDomains = array(custom.domains, "R2 custom domain list")
          .map((item) => record(item, "R2 custom domain"))
          .filter(({ enabled }) => enabled !== false)
          .map(({ domain }) => required(domain, "R2 custom domain name"))
          .sort();
        const objects = [
          ...(await collectResultItems(
            await cf.r2.buckets.objects.list(expectedBucket.name, { account_id: accountId }),
            (item) => {
              if (!item || typeof item !== "object") return undefined;
              const object = item as { key?: unknown; size?: unknown; etag?: unknown };
              return {
                key: required(object.key, "R2 object key"),
                size: integer(object.size, "R2 object size"),
                etag: required(object.etag, "R2 object etag"),
              };
            },
          )),
        ].sort((left, right) => left.key.localeCompare(right.key));
        if (typeof managed.enabled !== "boolean") {
          throw new Error("invalid Cloudflare legacy R2 public access");
        }
        const common = {
          name: required(info.name, "R2 bucket name"),
          location: required(info.location, "R2 bucket location"),
          storageClass: required(info.storage_class, "R2 bucket storage class"),
          jurisdiction: required(info.jurisdiction, "R2 bucket jurisdiction"),
          lifecycle,
          publicAccess: managed.enabled,
          managedDomain: required(managed.domain, "R2 managed domain"),
          customDomains,
          cors: await noCors(cf, expectedBucket.name, accountId),
        };
        return expectedBucket.authority === "preserve-only"
          ? ({ ...common, authority: "preserve-only", objectCount: objects.length } as const)
          : ({ ...common, authority: "delete-after-replacement", objects } as const);
      }),
    );

    return {
      schema: 1,
      authority: "delete-only",
      owner: expected.owner,
      worker: {
        name: expected.worker.name,
        versionId,
        deploymentId,
        retainedVersionIds: versions.filter((id) => id !== versionId),
        retainedDeploymentIds: deployments
          .map(({ id }) => required(id, "Worker deployment history id"))
          .filter((id) => id !== deploymentId)
          .sort(),
      },
      workflow: {
        name: required(workflow.name, "Workflow name"),
        id: required(workflow.id, "Workflow id"),
        className: required(workflow.class_name, "Workflow class"),
        scriptName: required(workflow.script_name, "Workflow script"),
        versionId: workflowVersionId,
        retainedVersionIds: orderedWorkflowVersions
          .map(({ id }) => id)
          .filter((id) => id !== workflowVersionId)
          .sort(),
      },
      container: {
        name: required(application.name, "container name"),
        id: applicationId,
        rolloutId: currentRollouts[0]!.id,
        imageTag: required(configuration.image, "container image"),
        resolvedImageDigest: expected.container.resolvedImageDigest,
        platform: { os: "linux", architecture: "amd64" },
        version: applicationVersion,
        schedulingPolicy: required(application.scheduling_policy, "container scheduling policy"),
        maxInstances: integer(application.max_instances, "container max instances"),
        rolloutActiveGracePeriod: integer(
          application.rollout_active_grace_period,
          "container rollout grace period",
        ),
        tiers: array(constraints.tiers, "container tiers")
          .map((tier) => String(integer(tier, "container tier")))
          .sort(),
        namespaceId: required(durableObjects.namespace_id, "container namespace id"),
        configuration: {
          vcpu: number(configuration.vcpu, "container vcpu"),
          memoryMiB: integer(configuration.memory_mib, "container memory"),
          diskSizeMb: integer(disk.size_mb, "container disk size"),
          runtime: required(configuration.runtime, "container runtime"),
          networkMode: required(network.mode, "container network mode"),
          assignIpv4: required(network.assign_ipv4, "container IPv4 assignment"),
          assignIpv6: required(network.assign_ipv6, "container IPv6 assignment"),
          bandwidthLimitMbps: integer(bandwidth.bandwidth_limit_mbps, "container bandwidth limit"),
          command: array(configuration.command, "container command").map((item) =>
            required(item, "container command item"),
          ),
          entrypoint: array(configuration.entrypoint, "container entrypoint").map((item) =>
            required(item, "container entrypoint item"),
          ),
        },
        rollouts,
      },
      namespaces,
      bindings,
      secretNames: secrets,
      schedules,
      workersDev: { enabled: subdomain.enabled, previewsEnabled: subdomain.previews_enabled },
      routes,
      secretSnapshot: {
        binding: SECRET_SNAPSHOT_KEY_BINDING,
        ownedKeyBindings: secrets.filter((name) =>
          name.startsWith(`${SECRET_SNAPSHOT_KEY_BINDING}_`),
        ),
        status: "runway-prefix-current-target-unverifiable",
        disposition: "prune-after-successful-replacement",
      },
      buckets: buckets.sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  resolveImageDigest(
    imageTag: string,
    platform: LegacyStackReceipt["container"]["platform"],
  ): Promise<string> {
    return resolveDockerImageDigest(imageTag, platform, this.#opts.fetch);
  }

  async read(): Promise<string | undefined> {
    let objects: readonly { key: string; etag: string }[];
    const prefix = `${this.#key}.versions/`;
    try {
      objects = await collectResultItems(
        await this.#opts.cf.r2.buckets.objects.list(this.#opts.stateBucket, {
          account_id: this.#opts.accountId,
          prefix,
        }),
        (item) => {
          if (!item || typeof item !== "object") return undefined;
          const object = item as { key?: unknown; etag?: unknown };
          return {
            key: required(object.key, "legacy state key"),
            etag: required(object.etag, "legacy state etag"),
          };
        },
      );
    } catch (error) {
      if (status(error, 404)) return undefined;
      throw error;
    }
    if (objects.length === 0) return undefined;
    const values = await Promise.all(
      objects.map(async ({ key }) => {
        const match = new RegExp(
          `^${this.#key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.versions\\/([0-9a-f]{64})\\.json$`,
        ).exec(key);
        if (!match) throw new Error("unknown Cloudflare legacy state object");
        const value = await textOf(
          await this.#opts.cf.r2.buckets.objects.get(this.#opts.stateBucket, key, {
            account_id: this.#opts.accountId,
          }),
        );
        if (sha256(value) !== match[1]) throw new Error("corrupt Cloudflare legacy state object");
        return value;
      }),
    );
    if (new Set(values).size !== 1) throw new Error("conflicting immutable legacy Stack state");
    return values[0];
  }

  async writeOnce(value: string): Promise<void> {
    const existing = await this.read();
    if (existing !== undefined) {
      if (existing !== value) throw new Error("legacy Stack state write conflict");
      return;
    }
    await this.#ensureStateBucket();
    const key = `${this.#key}.versions/${sha256(value)}.json`;
    await this.#opts.cf.r2.buckets.objects.upload(
      this.#opts.stateBucket,
      key,
      new TextEncoder().encode(value),
      { account_id: this.#opts.accountId },
    );
    const stored = await this.read();
    if (stored !== value) throw new Error("legacy Stack state persistence failed");
  }

  async #ensureStateBucket(): Promise<void> {
    try {
      await this.#opts.cf.r2.buckets.get(this.#opts.stateBucket, {
        account_id: this.#opts.accountId,
      });
    } catch (error) {
      if (!status(error, 404)) throw error;
      await this.#opts.cf.r2.buckets.create({
        account_id: this.#opts.accountId,
        name: this.#opts.stateBucket,
      });
    }
    lifecycleOf(
      await this.#opts.cf.r2.buckets.lifecycle.get(this.#opts.stateBucket, {
        account_id: this.#opts.accountId,
      }),
    );
    const managed = record(
      resultOf(
        await this.#opts.cf.r2.buckets.domains.managed.list(this.#opts.stateBucket, {
          account_id: this.#opts.accountId,
        }),
      ),
      "Stack state managed domain",
    );
    const custom = record(
      resultOf(
        await this.#opts.cf.r2.buckets.domains.custom.list(this.#opts.stateBucket, {
          account_id: this.#opts.accountId,
        }),
      ),
      "Stack state custom domains",
    );
    if (
      managed.enabled !== false ||
      array(custom.domains, "Stack state custom domains").length !== 0 ||
      (await noCors(this.#opts.cf, this.#opts.stateBucket, this.#opts.accountId))
    ) {
      throw new Error("Cloudflare legacy Stack state bucket is not private");
    }
  }
}
