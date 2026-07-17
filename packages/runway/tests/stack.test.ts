import { expect, test } from "vitest";

import {
  Stack,
  stackIdOf,
  type StackControl,
  type StackManifest,
  type StackReceipt,
} from "../src/stack.ts";

class MemoryControl implements StackControl {
  readonly #inventories = new Map<string, unknown>();
  readonly #objects = new Map<string, { value: string; revision: string }>();
  #revision = 0;

  inventory(manifest: StackManifest): Promise<StackReceipt> {
    const inventory = this.#inventories.get(manifest.owner.stackId);
    if (!inventory) throw new Error(`missing inventory for ${manifest.owner.stackId}`);
    return Promise.resolve(structuredClone(inventory) as StackReceipt);
  }

  read(key: string): Promise<{ readonly value: string; readonly revision: string } | undefined> {
    return Promise.resolve(structuredClone(this.#objects.get(key)));
  }

  compareAndSwap(key: string, revision: string | undefined, value: string): Promise<boolean> {
    const current = this.#objects.get(key);
    if (current?.revision !== revision || (!current && revision !== undefined)) {
      return Promise.resolve(false);
    }
    this.#revision += 1;
    this.#objects.set(key, { value, revision: String(this.#revision) });
    return Promise.resolve(true);
  }

  inventoryAs(manifest: StackManifest, receipt: unknown): void {
    this.#inventories.set(manifest.owner.stackId, structuredClone(receipt));
  }

  object(key: string, value: string): void {
    this.#revision += 1;
    this.#objects.set(key, { value, revision: String(this.#revision) });
  }

  values(): ReadonlyArray<string> {
    return [...this.#objects.values()].map(({ value }) => value);
  }

  keys(): ReadonlyArray<string> {
    return [...this.#objects.keys()];
  }
}

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`;

const manifestOf = (
  repositoryId: string,
  name: string,
  overrides: Partial<StackManifest> = {},
): StackManifest => ({
  owner: {
    accountId: "account-1",
    repositoryId,
    stackId: stackIdOf("account-1", repositoryId),
    name,
  },
  generation: digest(repositoryId === "repo-1" ? "1" : "2"),
  worker: { name, moduleDigest: digest("3") },
  workflow: { name, className: "DynamicWorkflow" },
  container: {
    name: `${name}-Sandbox`,
    image: `docker.io/cloudflare/sandbox@${digest("4")}`,
    imageDigest: digest("4"),
    platform: { os: "linux", architecture: "amd64" },
    runnerAbi: "runway-sandbox-v1",
    instanceType: "standard-4",
    maxInstances: 20,
    tiers: ["1", "2"],
  },
  namespaces: [
    {
      binding: "RUNWAY_GITHUB_COORDINATOR",
      className: "RunwayGitHubCoordinator",
      name: `${name}-RunwayGitHubCoordinator`,
    },
    { binding: "RunwaySandbox", className: "Sandbox", name: `${name}-Sandbox` },
  ],
  schedules: ["0 3 * * *"],
  workersDev: true,
  routes: ["ci.example.com/*"],
  bindings: [
    { name: "LOADER", type: "worker_loader" },
    { name: "RUNWAY_ARTIFACTS", type: "r2_bucket", target: "runway-account-1" },
    {
      name: "RUNWAY_GITHUB_COORDINATOR",
      type: "durable_object_namespace",
      target: "RunwayGitHubCoordinator",
    },
    { name: "RunwaySandbox", type: "durable_object_namespace", target: "Sandbox" },
    { name: "WORKFLOWS", type: "workflow", target: name },
  ],
  secretNames: [
    "RUNWAY_GITHUB_APP_ID",
    "RUNWAY_GITHUB_PRIVATE_KEY",
    "RUNWAY_GITHUB_WEBHOOK_SECRET",
    "RUNWAY_SECRET_SNAPSHOT_KEY",
    "RUNWAY_SECRET_SNAPSHOT_KEY_11111111111111111111111111111111",
  ],
  secretSnapshot: {
    binding: "RUNWAY_SECRET_SNAPSHOT_KEY",
    ownedKeyBindings: ["RUNWAY_SECRET_SNAPSHOT_KEY_11111111111111111111111111111111"],
  },
  buckets: [
    {
      name: "runway-account-1",
      shared: true,
      lifecycle: "retain",
      publicAccess: false,
      customDomains: [],
      objects: [
        {
          key: `artifacts/${repositoryId}/one`,
          shared: false,
          digest: digest(repositoryId === "repo-1" ? "5" : "6"),
        },
        { key: "content/shared", shared: true, digest: digest("7") },
      ],
    },
  ],
  ...overrides,
});

const receiptOf = (manifest: StackManifest, suffix = "1"): StackReceipt => ({
  owner: manifest.owner,
  generation: manifest.generation,
  worker: {
    name: manifest.worker.name,
    moduleDigest: manifest.worker.moduleDigest,
    versionId: `worker-version-${suffix}`,
    deploymentId: `worker-deployment-${suffix}`,
  },
  workflow: {
    name: manifest.workflow.name,
    className: manifest.workflow.className,
    id: `workflow-${suffix}`,
  },
  container: {
    name: manifest.container.name,
    id: `container-${suffix}`,
    rolloutId: `rollout-${suffix}`,
    image: manifest.container.image,
    imageDigest: manifest.container.imageDigest,
    platform: manifest.container.platform,
    runnerAbi: manifest.container.runnerAbi,
    instanceType: manifest.container.instanceType,
    maxInstances: manifest.container.maxInstances,
    tiers: manifest.container.tiers,
  },
  namespaces: manifest.namespaces.map(({ binding, className, name }) => ({
    binding,
    name,
    id: `namespace-${binding}-${suffix}`,
    className,
    scriptName: manifest.worker.name,
  })),
  schedules: manifest.schedules,
  workersDev: manifest.workersDev,
  bindings: manifest.bindings,
  secretNames: manifest.secretNames,
  secretSnapshot: manifest.secretSnapshot,
  buckets: manifest.buckets.map((bucket) => ({
    ...bucket,
    objects: bucket.objects.map((object) => ({
      ...object,
      etag: `etag-${suffix}-${object.key}`,
      version: `version-${suffix}-${object.key}`,
    })),
  })),
  routes: manifest.routes.map((pattern) => ({
    zoneId: `zone-${suffix}`,
    id: `route-${suffix}`,
    pattern,
  })),
});

test("Stack captures every exact owned field, persists canonical refs, and rereads the receipt", async () => {
  const control = new MemoryControl();
  const manifest = manifestOf("repo-1", "runway");
  const inventory = receiptOf(manifest);
  control.inventoryAs(manifest, inventory);
  const stack = new Stack(manifest, control);

  await expect(stack.capture()).resolves.toEqual(inventory);
  await expect(stack.read()).resolves.toEqual(inventory);
  await expect(stack.capture()).resolves.toEqual(inventory);

  const persisted = control.values().join("\n");
  expect(persisted).toContain('"versionId":"worker-version-1"');
  expect(persisted).toContain('"deploymentId":"worker-deployment-1"');
  expect(persisted).toContain('"rolloutId":"rollout-1"');
  expect(persisted).toContain('"imageDigest":"sha256:4444');
  expect(persisted).toContain('"architecture":"amd64","os":"linux"');
  expect(persisted).toContain('"name":"runway-Sandbox"');
  expect(persisted).toContain(
    '"binding":"RUNWAY_SECRET_SNAPSHOT_KEY","ownedKeyBindings":["RUNWAY_SECRET_SNAPSHOT_KEY_11111111111111111111111111111111"]',
  );
  expect(persisted).toContain('"shared":true');
  expect(persisted).toContain('"stackIds":["sha256:');
  expect(control.keys().join("\n")).not.toContain("repo-1/one");
});

test("two repository Stacks coexist while sharing only an identically configured bucket", async () => {
  const control = new MemoryControl();
  const first = manifestOf("repo-1", "runway-one");
  const second = manifestOf("repo-2", "runway-two");
  control.inventoryAs(first, receiptOf(first, "1"));
  control.inventoryAs(second, receiptOf(second, "2"));

  await new Stack(first, control).capture();
  await new Stack(second, control).capture();

  await expect(new Stack(first, control).read()).resolves.toEqual(receiptOf(first, "1"));
  await expect(new Stack(second, control).read()).resolves.toEqual(receiptOf(second, "2"));
  const stackIds = [first.owner.stackId, second.owner.stackId].sort();
  expect(control.values().join("\n")).toContain(`"stackIds":["${stackIds[0]}","${stackIds[1]}"]`);
  expect(
    control
      .values()
      .filter(
        (value) =>
          value.includes('"kind":"object"') &&
          value.includes(`"stackIds":["${stackIds[0]}","${stackIds[1]}"]`),
      ),
  ).toHaveLength(1);
});

test("cross-owner resource collisions and unknown shared state fail closed", async () => {
  const control = new MemoryControl();
  const first = manifestOf("repo-1", "runway");
  const second = manifestOf("repo-2", "runway", {
    owner: {
      accountId: "account-1",
      repositoryId: "repo-2",
      stackId: stackIdOf("account-1", "repo-2"),
      name: "runway-two",
    },
  });
  control.inventoryAs(first, receiptOf(first, "1"));
  control.inventoryAs(second, receiptOf(second, "2"));
  await new Stack(first, control).capture();
  const beforeCollision = control.values();
  await expect(new Stack(second, control).capture()).rejects.toThrow("owned by another Stack");
  expect(control.values()).toEqual(beforeCollision);

  const unknown = new MemoryControl();
  const manifest = manifestOf("repo-1", "runway");
  unknown.inventoryAs(manifest, receiptOf(manifest));
  unknown.object(Stack.refKey("bucket", "runway-account-1"), '{"schema":99}');
  await expect(new Stack(manifest, unknown).capture()).rejects.toThrow(
    "invalid persisted Stack ownership",
  );

  const incompatible = new MemoryControl();
  const one = manifestOf("repo-1", "runway-one");
  const twoBase = manifestOf("repo-2", "runway-two");
  const two = manifestOf("repo-2", "runway-two", {
    buckets: twoBase.buckets.map((bucket) => ({ ...bucket, lifecycle: "expire-30-days" })),
  });
  incompatible.inventoryAs(one, receiptOf(one, "1"));
  incompatible.inventoryAs(two, receiptOf(two, "2"));
  await new Stack(one, incompatible).capture();
  await expect(new Stack(two, incompatible).capture()).rejects.toThrow(
    "incompatible shared Stack state",
  );
});

test("inventory mismatches, unknown receipt fields, and tag-only images never become ownership", async () => {
  const control = new MemoryControl();
  const manifest = manifestOf("repo-1", "runway");
  control.inventoryAs(manifest, {
    ...receiptOf(manifest),
    secretNames: [...manifest.secretNames, "RUNWAY_SECRET_SNAPSHOT_KEY_unproven"],
  });
  await expect(new Stack(manifest, control).capture()).rejects.toThrow("secret snapshot");
  expect(control.values()).toEqual([]);

  const extra = new MemoryControl();
  extra.inventoryAs(manifest, { ...receiptOf(manifest), unknown: true });
  await expect(new Stack(manifest, extra).capture()).rejects.toThrow("invalid Stack receipt");
  expect(extra.values()).toEqual([]);

  expect(
    () =>
      new Stack(
        {
          ...manifest,
          container: {
            ...manifest.container,
            imageDigest: "docker.io/cloudflare/sandbox:0.12.3",
          },
        },
        control,
      ),
  ).toThrow("container image");
});
