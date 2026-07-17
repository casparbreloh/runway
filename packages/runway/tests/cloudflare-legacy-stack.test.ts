import { expect, test } from "vitest";

import type { CloudflareApi } from "../src/cloudflare-api.ts";
import {
  CloudflareLegacyStackControl,
  resolveDockerImageDigest,
} from "../src/cloudflare/legacy-stack.ts";
import type { LegacyStackReceipt } from "../src/legacy-stack.ts";
import { stackIdOf } from "../src/stack.ts";

const digest = `sha256:${"2".repeat(64)}`;

const expected: LegacyStackReceipt = {
  schema: 1,
  authority: "delete-only",
  owner: {
    accountId: "account",
    repositoryId: "github:1",
    stackId: stackIdOf("account", "github:1"),
  },
  worker: {
    name: "runway-monorepo",
    versionId: "worker-current",
    deploymentId: "deployment-current",
    retainedVersionIds: ["worker-old"],
    retainedDeploymentIds: ["deployment-old"],
  },
  workflow: {
    name: "runway-monorepo",
    id: "workflow-id",
    className: "DynamicWorkflow",
    scriptName: "runway-monorepo",
    versionId: "workflow-current",
    retainedVersionIds: ["workflow-old"],
  },
  container: {
    name: "runway-monorepo-Sandbox",
    id: "container-id",
    rolloutId: "rollout-current",
    imageTag: "docker.io/cloudflare/sandbox:0.12.3",
    resolvedImageDigest: digest,
    platform: { os: "linux", architecture: "amd64" },
    version: 3,
    schedulingPolicy: "default",
    maxInstances: 20,
    rolloutActiveGracePeriod: 0,
    tiers: ["1", "2"],
    namespaceId: "sandbox-namespace",
    configuration: {
      vcpu: 0.5,
      memoryMiB: 4096,
      diskSizeMb: 8000,
      runtime: "firecracker",
      networkMode: "private",
      assignIpv4: "none",
      assignIpv6: "none",
      bandwidthLimitMbps: 500,
      command: [],
      entrypoint: [],
    },
    rollouts: [
      { id: "rollout-current", status: "completed", currentVersion: 2, targetVersion: 3 },
      { id: "rollout-old", status: "replaced", currentVersion: 1, targetVersion: 2 },
    ],
  },
  namespaces: [
    {
      binding: "RunwaySandbox",
      name: "runway-monorepo_Sandbox",
      className: "Sandbox",
      id: "sandbox-namespace",
      scriptName: "runway-monorepo",
    },
  ],
  bindings: [
    { name: "RUNWAY_ARTIFACTS", type: "r2_bucket", target: "artifacts" },
    { name: "RunwaySandbox", type: "durable_object_namespace", target: "Sandbox" },
  ],
  secretNames: [
    "RUNWAY_SECRET_SNAPSHOT_KEY",
    "RUNWAY_SECRET_SNAPSHOT_KEY_0123456789abcdef0123456789abcdef",
  ],
  schedules: [],
  workersDev: { enabled: true, previewsEnabled: true },
  routes: [],
  secretSnapshot: {
    binding: "RUNWAY_SECRET_SNAPSHOT_KEY",
    ownedKeyBindings: ["RUNWAY_SECRET_SNAPSHOT_KEY_0123456789abcdef0123456789abcdef"],
    status: "runway-prefix-current-target-unverifiable",
    disposition: "prune-after-successful-replacement",
  },
  buckets: [
    {
      name: "artifacts",
      authority: "preserve-only",
      objectCount: 1,
      location: "EEUR",
      storageClass: "Standard",
      jurisdiction: "default",
      lifecycle: "default-multipart-abort-7-days",
      publicAccess: false,
      managedDomain: "pub-artifacts.r2.dev",
      customDomains: [],
      cors: false,
    },
    {
      name: "bootstrap",
      authority: "delete-after-replacement",
      objects: [{ key: "caches/one.tar.gz", size: 10, etag: "cache-etag" }],
      location: "EEUR",
      storageClass: "Standard",
      jurisdiction: "default",
      lifecycle: "default-multipart-abort-7-days",
      publicAccess: true,
      managedDomain: "pub-bootstrap.r2.dev",
      customDomains: [],
      cors: false,
    },
  ],
};

const result = (value: unknown): { result: unknown } => ({ result: value });

const lifecycle = result({
  rules: [
    {
      id: "Default Multipart Abort Rule",
      enabled: true,
      conditions: {},
      abortMultipartUploadsTransition: {
        condition: { type: "Age", maxAge: 604800 },
      },
    },
  ],
});

const fakeCloudflare = () => {
  const state = new Map<string, Uint8Array>();
  let uploads = 0;
  const cf = {
    workers: {
      scripts: {
        list: async () => result([{ id: "runway-monorepo" }]),
        versions: {
          list: async () => result([{ id: "worker-old" }, { id: "worker-current" }]),
          get: async () =>
            result({
              resources: {
                bindings: [
                  { name: "RUNWAY_ARTIFACTS", type: "r2_bucket", bucket_name: "artifacts" },
                  {
                    name: "RUNWAY_SECRET_SNAPSHOT_KEY",
                    type: "secret_text",
                  },
                  {
                    name: "RUNWAY_SECRET_SNAPSHOT_KEY_0123456789abcdef0123456789abcdef",
                    type: "secret_text",
                  },
                  {
                    name: "RunwaySandbox",
                    type: "durable_object_namespace",
                    class_name: "Sandbox",
                    namespace_id: "sandbox-namespace",
                  },
                ],
              },
            }),
        },
        deployments: {
          list: async () =>
            result({
              deployments: [
                {
                  id: "deployment-current",
                  versions: [{ version_id: "worker-current", percentage: 100 }],
                },
                { id: "deployment-old", versions: [{ version_id: "worker-old", percentage: 100 }] },
              ],
            }),
        },
        secrets: {
          list: async () => result(expected.secretNames.map((name) => ({ name }))),
        },
        schedules: { get: async () => result({ schedules: [] }) },
        subdomain: {
          get: async () => result({ enabled: true, previews_enabled: true }),
        },
      },
      routes: { list: async () => result([]) },
    },
    workflows: {
      list: async () =>
        result([
          {
            id: "workflow-id",
            name: "runway-monorepo",
            class_name: "DynamicWorkflow",
            script_name: "runway-monorepo",
          },
        ]),
      versions: {
        list: async () =>
          result([
            { id: "workflow-old", created_on: "2026-01-01T00:00:00Z" },
            { id: "workflow-current", created_on: "2026-01-02T00:00:00Z" },
          ]),
      },
    },
    containers: {
      applications: {
        list: async () =>
          result([
            {
              id: "container-id",
              name: "runway-monorepo-Sandbox",
              version: 3,
              scheduling_policy: "default",
              max_instances: 20,
              rollout_active_grace_period: 0,
              configuration: {
                image: "docker.io/cloudflare/sandbox:0.12.3",
                vcpu: 0.5,
                memory_mib: 4096,
                disk: { size_mb: 8000 },
                runtime: "firecracker",
                network: { mode: "private", assign_ipv4: "none", assign_ipv6: "none" },
                command: [],
                entrypoint: [],
              },
              network: { bandwidth_limit_mbps: 500 },
              constraints: { tiers: [1, 2] },
              durable_objects: { namespace_id: "sandbox-namespace" },
            },
          ]),
      },
      rollouts: {
        list: async () =>
          result([
            {
              id: "rollout-current",
              status: "completed",
              current_version: 2,
              target_version: 3,
            },
            {
              id: "rollout-old",
              status: "replaced",
              current_version: 1,
              target_version: 2,
            },
          ]),
      },
    },
    durableObjects: {
      namespaces: {
        list: async () =>
          result([
            {
              id: "sandbox-namespace",
              name: "runway-monorepo_Sandbox",
              class: "Sandbox",
              script: "runway-monorepo",
            },
          ]),
      },
    },
    zones: { list: async () => result([{ id: "zone" }]) },
    r2: {
      buckets: {
        get: async (bucket: string) => {
          if (bucket === "state") return result({ name: bucket });
          return result({
            name: bucket,
            location: "EEUR",
            storage_class: "Standard",
            jurisdiction: "default",
          });
        },
        create: async () => result({}),
        lifecycle: { get: async () => lifecycle },
        cors: {
          get: async () => {
            throw Object.assign(new Error("absent"), { status: 404 });
          },
        },
        domains: {
          managed: {
            list: async (bucket: string) =>
              result({
                enabled: bucket === "bootstrap",
                domain:
                  bucket === "bootstrap"
                    ? "pub-bootstrap.r2.dev"
                    : bucket === "artifacts"
                      ? "pub-artifacts.r2.dev"
                      : "pub-state.r2.dev",
              }),
          },
          custom: { list: async () => result({ domains: [] }) },
        },
        objects: {
          list: async (bucket: string) =>
            result(
              bucket === "artifacts"
                ? [{ key: "artifact", size: 1, etag: "artifact-etag" }]
                : bucket === "bootstrap"
                  ? [{ key: "caches/one.tar.gz", size: 10, etag: "cache-etag" }]
                  : [...state.entries()].map(([key, value]) => ({
                      key,
                      size: value.byteLength,
                      etag: "state-etag",
                    })),
            ),
          get: async (_bucket: string, key: string) => result(state.get(key)),
          upload: async (_bucket: string, key: string, value: Uint8Array) => {
            uploads += 1;
            state.set(key, value);
            return result({});
          },
        },
      },
    },
  } as unknown as CloudflareApi;
  return { cf, state, uploads: () => uploads };
};

test("resolves the tagged image through the independent linux/amd64 registry manifest", async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (url.startsWith("https://auth.docker.io/token?")) {
      return Response.json({ token: "registry-token" });
    }
    if (url.endsWith("/manifests/0.12.3")) {
      return Response.json({
        manifests: [
          {
            digest: `sha256:${"1".repeat(64)}`,
            platform: { os: "linux", architecture: "arm64" },
          },
          {
            digest: `sha256:${"2".repeat(64)}`,
            platform: { os: "linux", architecture: "amd64" },
          },
        ],
      });
    }
    return new Response("", {
      headers: { "docker-content-digest": `sha256:${"2".repeat(64)}` },
    });
  };

  await expect(
    resolveDockerImageDigest(
      "docker.io/cloudflare/sandbox:0.12.3",
      { os: "linux", architecture: "amd64" },
      fetcher,
    ),
  ).resolves.toBe(`sha256:${"2".repeat(64)}`);
  expect(requests).toHaveLength(3);
});

test("inventories every exact legacy surface and keeps state append-only", async () => {
  const fake = fakeCloudflare();
  const control = new CloudflareLegacyStackControl({
    cf: fake.cf,
    accountId: "account",
    expected,
    stateBucket: "state",
  });

  await expect(control.inventory()).resolves.toEqual(expected);
  await expect(control.read()).resolves.toBeUndefined();
  await control.writeOnce("receipt");
  await control.writeOnce("receipt");
  await expect(control.read()).resolves.toBe("receipt");
  expect(fake.uploads()).toBe(1);
  await expect(control.writeOnce("different")).rejects.toThrow("write conflict");
});

test("includes unknown legacy bindings so the fixed allowlist rejects drift", async () => {
  const fake = fakeCloudflare();
  const original = fake.cf.workers.scripts.versions.get.bind(fake.cf.workers.scripts.versions);
  fake.cf.workers.scripts.versions.get = async (...args) => {
    const response = (await original(...args)) as {
      result: { resources: { bindings: Record<string, unknown>[] } };
    };
    response.result.resources.bindings.push({ name: "UNKNOWN", type: "plain_text" });
    return response;
  };
  const inventory = await new CloudflareLegacyStackControl({
    cf: fake.cf,
    accountId: "account",
    expected,
    stateBucket: "state",
  }).inventory();

  expect(inventory.bindings).toContainEqual({ name: "UNKNOWN", type: "plain_text" });
  expect(inventory).not.toEqual(expected);
});
