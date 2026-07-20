import { expect, test } from "vitest";

import type { CloudflareApi } from "../../src/internal/cloudflare.ts";
import type { PreparedDeployment } from "../../src/internal/publish/artifacts.ts";
import {
  CloudflareStackControl,
  cloudflareStackManifest,
} from "../../src/internal/stack/cloudflare.ts";
import type { StackResource } from "../../src/internal/stack/stack.ts";

const artifactVersion = "c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c";

const deployment: PreparedDeployment = {
  host: new TextEncoder().encode("export default {}"),
  artifacts: [
    {
      workflowId: "check",
      artifactVersion,
      contents: new TextEncoder().encode("artifact"),
    },
  ],
  deploymentId: "build-deployment",
  secretSnapshotKey: "RUNWAY_SECRET_SNAPSHOT_KEY",
};

const manifest = cloudflareStackManifest({
  accountId: "account",
  repositoryId: "github:42",
  name: "runway",
  deployment,
  schedules: ["0 9 * * *"],
  secretNames: ["RUNWAY_SECRET_SNAPSHOT_KEY"],
  snapshotKeyBindings: [],
  dataBucket: "runway-data",
  stateBucket: "runway-state",
});

const providerBindings = manifest.bindings.map((binding) => ({
  name: binding.name,
  type: binding.type,
  ...(binding.type === "r2_bucket" ? { bucket_name: binding.target } : {}),
  ...(binding.type === "workflow" ? { workflow_name: binding.target } : {}),
  ...(binding.type === "durable_object_namespace"
    ? {
        class_name: binding.target,
        namespace_id: `namespace-${binding.name}`,
      }
    : {}),
}));

interface ProviderOverrides {
  readonly moduleDigest?: string;
  readonly workersDev?: boolean;
  readonly routes?: readonly {
    readonly id: string;
    readonly pattern: string;
    readonly script?: string;
  }[];
  readonly publicAccess?: boolean;
  readonly customDomains?: readonly string[];
  readonly deleteLifecycle?: boolean;
  readonly containerTiers?: readonly number[];
  readonly rolloutStatus?: string | null;
  readonly sandboxNamespaceName?: string;
  readonly providerEtag?: string;
  readonly workflowClass?: string;
  readonly containerImage?: string;
  readonly expandedInstanceType?: boolean;
  readonly containerSchedulingPolicy?: string;
  readonly containerInstances?: number;
  readonly containerGracePeriod?: number;
  readonly containerNamespaceId?: string;
  readonly rolloutId?: string;
  readonly sandboxNamespaceClass?: string;
  readonly objectEtag?: string;
  readonly deletions?: string[];
  readonly absent?: StackResource["type"];
  readonly routePattern?: string;
  readonly routeScript?: string;
  readonly routeGets?: unknown[];
}

const api = (overrides: ProviderOverrides = {}): CloudflareApi =>
  ({
    workers: {
      routes: {
        create: async () => ({ id: "created-route" }),
        list: async () => overrides.routes ?? [],
        get: async (id: string, params: unknown) => {
          overrides.routeGets?.push({ id, params });
          if (overrides.absent === "route") {
            throw Object.assign(new Error("not found"), { status: 404 });
          }
          return {
            id: "route-id",
            pattern: overrides.routePattern ?? "example.com/*",
            script: overrides.routeScript ?? "runway",
          };
        },
        delete: async (id: string) => {
          overrides.deletions?.push(`route:${id}`);
        },
      },
      scripts: {
        list: async () => (overrides.absent === "worker" ? [] : [{ id: "runway" }]),
        delete: async (name: string) => {
          overrides.deletions?.push(`worker:${name}`);
        },
        scriptAndVersionSettings: {
          get: async () => ({
            annotations: {
              "workers/tag": overrides.moduleDigest ?? manifest.worker.moduleDigest,
              "workers/message": manifest.generation,
            },
          }),
        },
        deployments: {
          list: async () => ({
            deployments: [
              {
                id: "worker-deployment",
                versions: [{ version_id: "worker-version", percentage: 100 }],
              },
            ],
          }),
        },
        versions: {
          get: async (
            _versionId: string,
            _params: { account_id: string; script_name: string },
          ) => ({
            resources: {
              bindings: providerBindings,
              script: { etag: overrides.providerEtag ?? "provider-etag" },
            },
          }),
        },
        schedules: { get: async () => ({ schedules: [{ cron: "0 9 * * *" }] }) },
        secrets: { list: async () => [{ name: "RUNWAY_SECRET_SNAPSHOT_KEY" }] },
        subdomain: {
          get: async () => ({
            enabled: overrides.workersDev ?? true,
            previews_enabled: true,
          }),
        },
      },
    },
    workflows: {
      list: async () =>
        overrides.absent === "workflow"
          ? []
          : [
              {
                id: "workflow-id",
                name: "runway",
                script_name: "runway",
                class_name: overrides.workflowClass ?? "DynamicWorkflow",
              },
            ],
      delete: async (name: string) => {
        overrides.deletions?.push(`workflow:${name}`);
      },
    },
    zones: {
      list: async () => [{ id: "zone-id", name: "example.com" }],
    },
    durableObjects: {
      namespaces: {
        list: async () =>
          overrides.absent === "namespace"
            ? []
            : manifest.namespaces.map(({ binding, className, name }) => ({
                id: `namespace-${binding}`,
                name: binding === "RunwaySandbox" ? (overrides.sandboxNamespaceName ?? name) : name,
                class:
                  binding === "RunwaySandbox"
                    ? (overrides.sandboxNamespaceClass ?? className)
                    : className,
                script: "runway",
              })),
      },
    },
    containers: {
      applications: {
        list: async () =>
          overrides.absent === "container"
            ? []
            : [
                {
                  id: "container-id",
                  name: "runway",
                  scheduling_policy: overrides.containerSchedulingPolicy ?? "default",
                  instances: overrides.containerInstances ?? 0,
                  max_instances: manifest.container.maxInstances,
                  constraints: {
                    tiers: overrides.containerTiers ?? manifest.container.tiers.map(Number),
                  },
                  rollout_active_grace_period: overrides.containerGracePeriod ?? 0,
                  durable_objects: {
                    namespace_id: overrides.containerNamespaceId ?? "namespace-RunwaySandbox",
                  },
                  configuration: {
                    image: overrides.containerImage ?? manifest.container.image,
                    ...(overrides.expandedInstanceType
                      ? { vcpu: 4, memory_mib: 12_288, disk: { size_mb: 20_000 } }
                      : { instance_type: manifest.container.instanceType }),
                  },
                },
              ],
        delete: async (id: string) => {
          overrides.deletions?.push(`container:${id}`);
        },
      },
      rollouts: {
        list: async () =>
          overrides.rolloutStatus === null
            ? []
            : [
                {
                  id: overrides.rolloutId ?? "rollout-id",
                  status: overrides.rolloutStatus ?? "completed",
                },
              ],
      },
    },
    r2: {
      buckets: {
        get: async (name: string) => {
          if (overrides.absent === "bucket") {
            throw Object.assign(new Error("not found"), { status: 404 });
          }
          return { name };
        },
        delete: async (name: string) => {
          overrides.deletions?.push(`bucket:${name}`);
        },
        lifecycle: {
          get: async () => ({
            rules: overrides.deleteLifecycle
              ? [{ id: "delete", enabled: true, deleteObjectsTransition: { condition: "x" } }]
              : [],
          }),
        },
        domains: {
          managed: {
            list: async () => ({
              enabled: overrides.publicAccess ?? false,
              domain: "bucket.r2.dev",
            }),
          },
          custom: {
            list: async () => ({
              domains: (overrides.customDomains ?? []).map((domain) => ({ domain, enabled: true })),
            }),
          },
        },
        objects: {
          list: async (bucket: string) =>
            bucket === "runway-data" && overrides.absent !== "object"
              ? [
                  {
                    key: `artifacts/${artifactVersion}.json`,
                    etag: overrides.objectEtag ?? "artifact-etag",
                  },
                ]
              : [],
          get: async (_key: string, _params: { account_id: string; bucket_name: string }) =>
            new TextEncoder().encode("artifact"),
          delete: async (key: string, params: { bucket_name: string }) => {
            overrides.deletions?.push(`object:${params.bucket_name}/${key}`);
          },
        },
      },
    },
  }) as unknown as CloudflareApi;

const control = (cf: CloudflareApi) =>
  new CloudflareStackControl({
    cf,
    accountId: "account",
    registry: [],
    deployment,
    secretBindings: {},
    stateBucket: "runway-state",
    ready: async () => {},
  });

test("inventory rejects a deployed Worker whose provider-observed build identity drifted", async () => {
  await expect(
    control(api({ moduleDigest: `sha256:${"f".repeat(64)}` })).inventory(manifest),
  ).rejects.toThrow("Worker module");
});

test("inventory rejects provider-observed workers.dev drift", async () => {
  await expect(control(api({ workersDev: false })).inventory(manifest)).rejects.toThrow(
    "workers.dev",
  );
});

test("inventory rejects an unowned provider route instead of reporting no routes", async () => {
  await expect(
    control(
      api({ routes: [{ id: "route-id", pattern: "example.com/*", script: "runway" }] }),
    ).inventory(manifest),
  ).rejects.toThrow("route");
});

test("inventory rejects provider-observed bucket exposure drift", async () => {
  await expect(control(api({ publicAccess: true })).inventory(manifest)).rejects.toThrow(
    "public access",
  );
});

test("inventory rejects provider-observed bucket lifecycle and custom-domain drift", async () => {
  await expect(control(api({ deleteLifecycle: true })).inventory(manifest)).rejects.toThrow(
    "lifecycle",
  );
  await expect(
    control(api({ customDomains: ["cache.example.com"] })).inventory(manifest),
  ).rejects.toThrow("custom domains");
});

test("inventory returns exact provider evidence after every desired field is verified", async () => {
  await expect(control(api()).inventory(manifest)).resolves.toMatchObject({
    worker: {
      moduleDigest: manifest.worker.moduleDigest,
      providerEtag: "provider-etag",
      versionId: "worker-version",
      deploymentId: "worker-deployment",
    },
    workflow: {
      id: "workflow-id",
      name: "runway",
      className: "DynamicWorkflow",
    },
    container: {
      id: "container-id",
      rolloutId: "rollout-id",
      image: manifest.container.image,
    },
    workersDev: true,
    routes: [],
    buckets: [
      expect.objectContaining({
        name: "runway-data",
        lifecycle: "retain",
        publicAccess: false,
        customDomains: [],
      }),
      expect.objectContaining({
        name: "runway-state",
        lifecycle: "stack-state",
        publicAccess: false,
        customDomains: [],
      }),
    ],
  });
});

test("inventory rejects container configuration and active-rollout drift", async () => {
  await expect(control(api({ containerTiers: [2] })).inventory(manifest)).rejects.toThrow(
    "container",
  );
  await expect(control(api({ rolloutStatus: "reverted" })).inventory(manifest)).rejects.toThrow(
    "rollout",
  );
  for (const drift of [
    { containerSchedulingPolicy: "replacement" },
    { containerGracePeriod: 1 },
    { containerNamespaceId: "replacement-namespace" },
  ]) {
    await expect(control(api(drift)).inventory(manifest)).rejects.toThrow("container");
  }
});

test("inventory records exact absence of an initial automatic container rollout", async () => {
  await expect(control(api({ rolloutStatus: null })).inventory(manifest)).resolves.toMatchObject({
    container: { id: "container-id" },
  });
});

test("inventory normalizes Cloudflare's expanded standard-4 resources", async () => {
  await expect(
    control(api({ expandedInstanceType: true, containerInstances: 7 })).inventory(manifest),
  ).resolves.toMatchObject({ container: { instanceType: "standard-4" } });
});

test("inventory rejects Durable Object namespace identity drift", async () => {
  await expect(
    control(api({ sandboxNamespaceName: "another_Sandbox" })).inventory(manifest),
  ).rejects.toThrow("namespace");
});

test("Worker deletion evidence distinguishes exact identity from drift", async () => {
  const receipt = await control(api()).inventory(manifest);
  const resource = { type: "worker" as const, ...receipt.worker };

  await expect(control(api()).hasResource(resource)).resolves.toBe(true);
  await expect(
    control(api({ providerEtag: "replacement-etag" })).hasResource(resource),
  ).rejects.toThrow("Worker deletion evidence changed");
});

test("every non-Worker deletion check throws on replacement drift", async () => {
  const receipt = await control(api()).inventory(manifest);
  const bucket = receipt.buckets[0]!;
  const cases: readonly [StackResource, ProviderOverrides, string][] = [
    [
      { type: "workflow", ...receipt.workflow, scriptName: receipt.worker.name },
      { workflowClass: "ReplacementWorkflow" },
      "Workflow",
    ],
    [
      { type: "container", ...receipt.container },
      { rolloutId: "replacement-rollout" },
      "container",
    ],
    [
      { type: "namespace", ...receipt.namespaces[1]! },
      { sandboxNamespaceClass: "ReplacementSandbox" },
      "namespace",
    ],
    [
      {
        type: "bucket",
        name: bucket.name,
        lifecycle: bucket.lifecycle,
        publicAccess: bucket.publicAccess,
        customDomains: bucket.customDomains,
      },
      { publicAccess: true },
      "bucket",
    ],
    [
      {
        type: "object",
        bucket: bucket.name,
        ...bucket.objects[0]!,
      },
      { objectEtag: "replacement-etag" },
      "object",
    ],
  ];

  for (const [resource, drift, label] of cases) {
    await expect(control(api()).hasResource(resource), label).resolves.toBe(true);
    await expect(control(api(drift)).hasResource(resource), label).rejects.toThrow(
      "deletion evidence changed",
    );
  }
});

test("container deletion verifies every managed application field from its receipt", async () => {
  const receipt = await control(api()).inventory(manifest);
  const resource = { type: "container" as const, ...receipt.container };
  for (const drift of [
    { containerSchedulingPolicy: "replacement" },
    { containerGracePeriod: 1 },
    { containerNamespaceId: "replacement-namespace" },
  ]) {
    await expect(control(api(drift)).hasResource(resource)).rejects.toThrow(
      "container deletion evidence changed",
    );
  }
});

test("delete mutates the provider only after exact evidence matches", async () => {
  const receipt = await control(api()).inventory(manifest);
  const bucket = receipt.buckets[0]!;
  const resources: readonly [StackResource, string][] = [
    [{ type: "worker", ...receipt.worker }, "worker:runway"],
    [{ type: "workflow", ...receipt.workflow, scriptName: receipt.worker.name }, "workflow:runway"],
    [{ type: "container", ...receipt.container }, "container:container-id"],
    [
      {
        type: "bucket",
        name: bucket.name,
        lifecycle: bucket.lifecycle,
        publicAccess: bucket.publicAccess,
        customDomains: bucket.customDomains,
      },
      "bucket:runway-data",
    ],
    [
      { type: "object", bucket: bucket.name, ...bucket.objects[0]! },
      `object:runway-data/${bucket.objects[0]!.key}`,
    ],
  ];

  for (const [resource, expected] of resources) {
    const deletions: string[] = [];
    await control(api({ deletions })).deleteResource(resource);
    expect(deletions).toEqual([expected]);
  }

  const deletions: string[] = [];
  await expect(
    control(api({ deletions, rolloutId: "replacement-rollout" })).deleteResource({
      type: "container",
      ...receipt.container,
    }),
  ).rejects.toThrow("deletion evidence changed");
  expect(deletions).toEqual([]);
});

test("absent resources are distinct from drift and deletion stays idempotent", async () => {
  const receipt = await control(api()).inventory(manifest);
  const bucket = receipt.buckets[0]!;
  const resources: readonly StackResource[] = [
    { type: "worker", ...receipt.worker },
    { type: "workflow", ...receipt.workflow, scriptName: receipt.worker.name },
    { type: "container", ...receipt.container },
    { type: "namespace", ...receipt.namespaces[1]! },
    {
      type: "bucket",
      name: bucket.name,
      lifecycle: bucket.lifecycle,
      publicAccess: bucket.publicAccess,
      customDomains: bucket.customDomains,
    },
    { type: "object", bucket: bucket.name, ...bucket.objects[0]! },
  ];

  for (const resource of resources) {
    const deletions: string[] = [];
    const absent = api({ absent: resource.type, deletions });
    await expect(control(absent).hasResource(resource)).resolves.toBe(false);
    await expect(control(absent).deleteResource(resource)).resolves.toBeUndefined();
    expect(deletions).toEqual([]);
  }
});

test("route deletion uses exact zone-scoped evidence", async () => {
  const routeGets: unknown[] = [];
  const route: StackResource = {
    type: "route",
    zoneId: "zone-id",
    id: "route-id",
    pattern: "example.com/*",
    scriptName: "runway",
  };
  await expect(control(api({ routeGets })).hasResource(route)).resolves.toBe(true);
  expect(routeGets).toEqual([{ id: "route-id", params: { zone_id: "zone-id" } }]);
  await expect(
    control(api({ routePattern: "replacement.example.com/*" })).hasResource(route),
  ).rejects.toThrow("route deletion evidence changed");
  await expect(
    control(api({ routeScript: "replacement-worker" })).hasResource(route),
  ).rejects.toThrow("route deletion evidence changed");
  await expect(control(api({ absent: "route" })).hasResource(route)).resolves.toBe(false);

  const deletions: string[] = [];
  await control(api({ deletions })).deleteResource(route);
  expect(deletions).toEqual(["route:route-id"]);
});

test("route reassignment after capture blocks deletion", async () => {
  const routed = { ...manifest, routes: ["example.com/*"] };
  const receipt = await control(
    api({ routes: [{ id: "route-id", pattern: "example.com/*", script: "runway" }] }),
  ).inventory(routed);
  const route: StackResource = { type: "route", ...receipt.routes[0]! };
  const deletions: string[] = [];

  await expect(
    control(api({ routeScript: "replacement-worker", deletions })).deleteResource(route),
  ).rejects.toThrow("route deletion evidence changed");
  expect(deletions).toEqual([]);
});

interface ApplyCalls {
  readonly operations: string[];
  readonly bucketCreates: unknown[];
  readonly containerCreates: unknown[];
  readonly containerModifies: unknown[];
  readonly rolloutCreates: unknown[];
  readonly workflowUpdates: unknown[];
  readonly artifactParams: unknown[];
  readonly artifactOptions: unknown[];
  readonly routeCreates: unknown[];
  metadata?: Record<string, unknown>;
}

interface ApplyOverrides {
  readonly worker?: "absent" | "present";
  readonly bucket?: "present" | "missing" | "forbidden";
  readonly workflowOwner?: string;
  readonly application?: "absent" | "exact" | "stale";
  readonly expandedInstanceType?: boolean;
  readonly providerInstances?: number;
  readonly rolloutStatus?: string;
  readonly rolloutError?: Error;
  readonly artifact?: "absent" | "exact" | "conflict" | "ambiguous" | "failed";
  readonly routes?: readonly {
    readonly id: string;
    readonly pattern: string;
    readonly script?: string;
  }[];
  readonly zoneName?: string;
}

const applyApi = (calls: ApplyCalls, overrides: ApplyOverrides = {}): CloudflareApi => {
  let routes = [...(overrides.routes ?? [])];
  let artifact =
    overrides.bucket === "missing" || overrides.artifact === "absent"
      ? undefined
      : new TextEncoder().encode(overrides.artifact === "conflict" ? "replacement" : "artifact");
  const application = {
    id: "container-id",
    name: "runway",
    scheduling_policy: "default",
    instances: overrides.providerInstances ?? 0,
    max_instances: manifest.container.maxInstances,
    constraints: { tiers: manifest.container.tiers.map(Number) },
    rollout_active_grace_period: 0,
    durable_objects: { namespace_id: "namespace-RunwaySandbox" },
    configuration: {
      image:
        overrides.application === "stale"
          ? "docker.io/replacement@sha256:bad"
          : manifest.container.image,
      ...(overrides.expandedInstanceType
        ? { vcpu: 4, memory_mib: 12_288, disk: { size_mb: 20_000 } }
        : { instance_type: manifest.container.instanceType }),
    },
  };
  return {
    workers: {
      routes: {
        list: async () => routes,
        create: async (params: { zone_id: string; pattern: string; script: string }) => {
          calls.routeCreates.push(params);
          const route = {
            id: `route-${routes.length + 1}`,
            pattern: params.pattern,
            script: params.script,
          };
          routes = [...routes, route];
          return route;
        },
      },
      scripts: {
        list: async () => (overrides.worker === "present" ? [{ id: "runway" }] : []),
        update: async (_name: string, params: { metadata: unknown }) => {
          calls.operations.push("worker-upload");
          calls.metadata = params.metadata as unknown as Record<string, unknown>;
        },
        versions: {
          list: async () => [{ id: "worker-version" }],
          get: async (
            _versionId: string,
            _params: { account_id: string; script_name: string },
          ) => ({
            resources: {
              bindings: [
                {
                  type: "durable_object_namespace",
                  name: "RunwaySandbox",
                  class_name: "Sandbox",
                  namespace_id: "namespace-RunwaySandbox",
                },
              ],
            },
          }),
        },
        schedules: {
          update: async () => {},
        },
        subdomain: {
          create: async () => {},
        },
      },
      subdomains: {
        get: async () => ({ subdomain: "tester" }),
      },
    },
    workflows: {
      list: async () =>
        overrides.workflowOwner ? [{ name: "runway", script_name: overrides.workflowOwner }] : [],
      update: async (...args: unknown[]) => {
        calls.workflowUpdates.push(args);
      },
    },
    zones: {
      list: async () => [{ id: "zone-id", name: overrides.zoneName ?? "example.com" }],
    },
    containers: {
      applications: {
        list: async () =>
          overrides.application === undefined || overrides.application === "absent"
            ? []
            : [application],
        create: async (params: unknown) => {
          calls.containerCreates.push(params);
        },
        modify: async (...args: unknown[]) => {
          calls.containerModifies.push(args);
        },
      },
      rollouts: {
        create: async (...args: unknown[]) => {
          calls.rolloutCreates.push(args);
          if (overrides.rolloutError) throw overrides.rolloutError;
          return { id: "rollout-id" };
        },
        get: async () => ({ status: overrides.rolloutStatus ?? "completed" }),
      },
    },
    r2: {
      buckets: {
        get: async () => {
          if (overrides.bucket === "forbidden") {
            throw Object.assign(new Error("forbidden"), { status: 403 });
          }
          if (overrides.bucket === "missing") {
            throw Object.assign(new Error("not found"), { status: 404 });
          }
          return {};
        },
        create: async (params: unknown) => {
          calls.bucketCreates.push(params);
        },
        objects: {
          get: async (_key: string, _params: { account_id: string; bucket_name: string }) => {
            if (!artifact) throw Object.assign(new Error("not found"), { status: 404 });
            return artifact;
          },
          upload: async (key: string, _body: unknown, params: unknown, options: unknown) => {
            calls.operations.push(`artifact-upload:${key}`);
            calls.artifactParams.push(params);
            calls.artifactOptions.push(options);
            if (overrides.artifact === "failed") throw new Error("upload failed");
            artifact = new TextEncoder().encode("artifact");
            if (overrides.artifact === "ambiguous") throw new Error("ambiguous upload");
          },
        },
      },
    },
  } as unknown as CloudflareApi;
};

const applyCalls = (): ApplyCalls => ({
  operations: [],
  bucketCreates: [],
  containerCreates: [],
  containerModifies: [],
  rolloutCreates: [],
  workflowUpdates: [],
  artifactParams: [],
  artifactOptions: [],
  routeCreates: [],
});

test("apply refuses Dynamic Workflow takeover before any provider mutation", async () => {
  const calls = applyCalls();
  await expect(
    control(applyApi(calls, { workflowOwner: "another-worker" })).apply(manifest),
  ).rejects.toThrow("already belongs to Worker another-worker");
  expect(calls.operations).toEqual([]);
  expect(calls.workflowUpdates).toEqual([]);
});

test("apply creates missing storage, publishes content before host, and uploads fresh bindings", async () => {
  const calls = applyCalls();
  let ready = 0;
  const stack = new CloudflareStackControl({
    cf: applyApi(calls, { bucket: "missing" }),
    accountId: "account",
    registry: [],
    deployment,
    secretBindings: { RUNWAY_SECRET_SNAPSHOT_KEY: "snapshot" },
    stateBucket: "runway-state",
    ready: async () => {
      ready += 1;
    },
  });

  await stack.apply(manifest);

  expect(calls.bucketCreates).toEqual([{ account_id: "account", name: "runway-data" }]);
  expect(calls.operations).toEqual([
    `artifact-upload:artifacts/${artifactVersion}.json`,
    "worker-upload",
  ]);
  expect(calls.artifactParams).toEqual([
    {
      account_id: "account",
      bucket_name: "runway-data",
    },
  ]);
  expect(calls.artifactOptions).toEqual([{ headers: { "If-None-Match": "*" } }]);
  expect(calls.metadata).toMatchObject({
    annotations: {
      "workers/tag": manifest.worker.moduleDigest,
      "workers/message": manifest.generation,
    },
    keep_bindings: ["secret_text"],
    containers: [{ class_name: "Sandbox" }],
    migrations: {
      new_tag: "runway-v1",
      new_sqlite_classes: ["RunwayGitHubCoordinator", "Sandbox"],
    },
    bindings: expect.arrayContaining([
      { type: "worker_loader", name: "LOADER" },
      {
        type: "r2_bucket",
        name: "RUNWAY_DATA",
        bucket_name: "runway-data",
      },
      {
        type: "secret_text",
        name: "RUNWAY_SECRET_SNAPSHOT_KEY",
        text: "snapshot",
      },
    ]),
  });
  expect(calls.metadata?.containers).toEqual([{ class_name: "Sandbox" }]);
  expect(calls.metadata?.exports).toBeUndefined();
  expect(calls.containerCreates).toHaveLength(1);
  expect(calls.workflowUpdates).toHaveLength(1);
  expect(ready).toBe(1);
});

test("apply reuses storage and exact containers, and explains storage permission failures", async () => {
  const reused = applyCalls();
  await control(applyApi(reused, { worker: "present", application: "exact" })).apply(manifest);
  expect(reused.bucketCreates).toEqual([]);
  expect(reused.containerCreates).toEqual([]);
  expect(reused.containerModifies).toEqual([]);
  expect(reused.rolloutCreates).toEqual([]);
  expect(reused.metadata?.migrations).toBeUndefined();

  const expanded = applyCalls();
  await control(
    applyApi(expanded, {
      worker: "present",
      application: "exact",
      expandedInstanceType: true,
      providerInstances: 7,
    }),
  ).apply(manifest);
  expect(expanded.containerModifies).toEqual([]);
  expect(expanded.rolloutCreates).toEqual([]);

  const forbidden = applyCalls();
  await expect(
    control(applyApi(forbidden, { bucket: "forbidden" })).apply(manifest),
  ).rejects.toThrow("Workers R2 Storage Write permission");
  expect(forbidden.operations).toEqual([]);
});

test("apply never overwrites an existing conflicting content-addressed artifact", async () => {
  const conflict = applyCalls();
  await expect(
    control(applyApi(conflict, { artifact: "conflict" })).apply(manifest),
  ).rejects.toThrow("conflicts with workflow artifact");
  expect(conflict.operations).toEqual([]);

  const ambiguous = applyCalls();
  await expect(
    control(applyApi(ambiguous, { artifact: "ambiguous", bucket: "missing" })).apply(manifest),
  ).resolves.toBeUndefined();
  expect(ambiguous.operations).toEqual([
    `artifact-upload:artifacts/${artifactVersion}.json`,
    "worker-upload",
  ]);

  const failed = applyCalls();
  await expect(
    control(applyApi(failed, { artifact: "failed", bucket: "missing" })).apply(manifest),
  ).rejects.toThrow("upload failed");
  expect(failed.operations).toEqual([`artifact-upload:artifacts/${artifactVersion}.json`]);
});

test("apply and inventory own exact non-empty zone-scoped routes", async () => {
  const routed = { ...manifest, routes: ["ci.example.com/*"] };
  const calls = applyCalls();
  await control(applyApi(calls)).apply(routed);
  expect(calls.routeCreates).toEqual([
    { zone_id: "zone-id", pattern: "ci.example.com/*", script: "runway" },
  ]);

  await expect(
    control(
      api({
        routes: [{ id: "route-id", pattern: "ci.example.com/*", script: "runway" }],
      }),
    ).inventory(routed),
  ).resolves.toMatchObject({
    routes: [
      {
        zoneId: "zone-id",
        id: "route-id",
        pattern: "ci.example.com/*",
        scriptName: "runway",
      },
    ],
  });

  const takeover = applyCalls();
  await expect(
    control(
      applyApi(takeover, {
        routes: [{ id: "route-id", pattern: "ci.example.com/*", script: "another-worker" }],
      }),
    ).apply(routed),
  ).rejects.toThrow("belongs to another Worker");
  expect(takeover.operations).toEqual([]);
  expect(takeover.routeCreates).toEqual([]);
});

test("apply reconciles stale container configuration and surfaces rollout failures", async () => {
  const reconciled = applyCalls();
  await control(applyApi(reconciled, { application: "stale" })).apply(manifest);
  expect(reconciled.containerModifies).toHaveLength(1);
  expect(reconciled.rolloutCreates).toHaveLength(1);

  const creationFailure = applyCalls();
  await expect(
    control(
      applyApi(creationFailure, {
        application: "stale",
        rolloutError: new Error("rollout rejected"),
      }),
    ).apply(manifest),
  ).rejects.toThrow("rollout rejected");

  const reverted = applyCalls();
  await expect(
    control(applyApi(reverted, { application: "stale", rolloutStatus: "reverted" })).apply(
      manifest,
    ),
  ).rejects.toThrow("container rollout reverted");
});

const stateApi = (
  initial: Readonly<Record<string, string>> | undefined,
  config: {
    readonly publicAccess?: boolean;
    readonly deleteObjects?: boolean;
    readonly preparationFailures?: number;
  } = {},
) => {
  let exists = initial !== undefined;
  let preparationFailures = config.preparationFailures ?? 0;
  const objects = new Map(Object.entries(initial ?? {}));
  let creates = 0;
  let uploads = 0;
  const cf = {
    r2: {
      buckets: {
        get: async () => {
          if (!exists) throw Object.assign(new Error("not found"), { status: 404 });
          return {};
        },
        create: async () => {
          exists = true;
          creates += 1;
        },
        lifecycle: {
          get: async () => {
            if (preparationFailures > 0) {
              preparationFailures -= 1;
              throw new Error("transient state preparation failure");
            }
            return {
              rules: config.deleteObjects
                ? [{ enabled: true, deleteObjectsTransition: { condition: { type: "Age" } } }]
                : [],
            };
          },
        },
        domains: {
          managed: { list: async () => ({ enabled: config.publicAccess ?? false }) },
          custom: { list: async () => ({ domains: [] }) },
        },
        objects: {
          list: async (_bucket: string, { prefix = "" }: { prefix?: string }) =>
            [...objects.keys()]
              .filter((key) => key.startsWith(prefix))
              .map((key) => ({ key, etag: `etag:${key}` })),
          upload: async (key: string, body: Uint8Array) => {
            uploads += 1;
            objects.set(key, new TextDecoder().decode(body));
          },
          get: async (key: string) => objects.get(key),
          delete: async (key: string) => {
            objects.delete(key);
          },
        },
      },
    },
  } as unknown as CloudflareApi;
  return { cf, objects, creates: () => creates, uploads: () => uploads };
};

test("append-only state shares missing bucket preparation across concurrent writes", async () => {
  const state = stateApi(undefined);
  const stack = control(state.cf);
  await Promise.all([
    stack.writeOnce("stack/v2/receipts/owner/generation.json", "one"),
    stack.writeOnce("stack/v2/claims/worker/runway.json", "two"),
  ]);
  expect(state.creates()).toBe(1);
  await expect(stack.read("stack/v2/receipts/owner/generation.json")).resolves.toMatchObject({
    value: "one",
  });
});

test("append-only state shares a failed preparation and retries it", async () => {
  const state = stateApi(undefined, { preparationFailures: 1 });
  const stack = control(state.cf);
  const first = await Promise.allSettled([
    stack.writeOnce("stack/v2/receipts/owner/generation.json", "one"),
    stack.writeOnce("stack/v2/claims/worker/runway.json", "two"),
  ]);
  expect(first.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
  await Promise.all([
    stack.writeOnce("stack/v2/receipts/owner/generation.json", "one"),
    stack.writeOnce("stack/v2/claims/worker/runway.json", "two"),
  ]);
  expect(state.creates()).toBe(1);
});

test("append-only state adopts an empty shared bucket and rejects conflicting storage", async () => {
  const empty = stateApi({});
  await expect(
    control(empty.cf).writeOnce("stack/v2/receipts/owner/generation.json", "one"),
  ).resolves.toBeUndefined();
  expect(empty.creates()).toBe(0);

  const logical = "stack/v2/receipts/owner/generation.json";
  const conflicting = stateApi({
    [`${logical}.versions/one.json`]: "one",
    [`${logical}.versions/two.json`]: "two",
  });
  await expect(control(conflicting.cf).read(logical)).rejects.toThrow("conflicting immutable");
});

test("append-only state verifies private retained storage before its first write", async () => {
  const physical =
    "stack/v2/claims/existing.json.versions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json";
  for (const config of [{ publicAccess: true }, { deleteObjects: true }]) {
    const state = stateApi({ [physical]: "existing" }, config);
    await expect(
      control(state.cf).writeOnce("stack/v2/receipts/owner/generation.json", "one"),
    ).rejects.toThrow("not private and retained");
    expect(state.uploads()).toBe(0);
  }
});
