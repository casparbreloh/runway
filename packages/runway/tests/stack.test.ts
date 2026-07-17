import { expect, test } from "vitest";

import {
  Stack,
  stackIdOf,
  type StackControl,
  type StackManifest,
  type StackReceipt,
  type StackResource,
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

  list(prefix: string): Promise<readonly { key: string; value: string; revision: string }[]> {
    return Promise.resolve(
      [...this.#objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, ...structuredClone(value) })),
    );
  }

  writeOnce(key: string, value: string): Promise<void> {
    const current = this.#objects.get(key);
    if (current && current.value !== value) throw new Error("immutable Stack state conflict");
    if (current) return Promise.resolve();
    this.#revision += 1;
    this.#objects.set(key, { value, revision: String(this.#revision) });
    return Promise.resolve();
  }

  deleteState(key: string, revision: string): Promise<void> {
    if (this.#objects.get(key)?.revision === revision) this.#objects.delete(key);
    return Promise.resolve();
  }

  apply(_manifest: StackManifest): Promise<void> {
    throw new Error("Stack apply unavailable");
  }

  deleteResource(_resource: StackResource): Promise<void> {
    throw new Error("Stack deletion unavailable");
  }

  hasResource(_resource: StackResource): Promise<boolean> {
    throw new Error("Stack inventory unavailable");
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
    schedulingPolicy: "default",
    instances: 0,
    maxInstances: 20,
    tiers: ["1", "2"],
    rolloutActiveGracePeriod: 0,
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
    providerEtag: `provider-etag-${suffix}`,
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
    schedulingPolicy: manifest.container.schedulingPolicy,
    instances: manifest.container.instances,
    maxInstances: manifest.container.maxInstances,
    tiers: manifest.container.tiers,
    rolloutActiveGracePeriod: manifest.container.rolloutActiveGracePeriod,
    namespaceId: `namespace-RunwaySandbox-${suffix}`,
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
  expect(control.values().join("\n")).toContain(`"stackIds":["${stackIds[0]}"]`);
  expect(control.values().join("\n")).toContain(`"stackIds":["${stackIds[1]}"]`);
  expect(
    control
      .values()
      .filter(
        (value) =>
          value.includes('"kind":"object"') &&
          stackIds.some((stackId) => value.includes(`"stackIds":["${stackId}"]`)),
      ),
  ).toHaveLength(2);
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
  await expect(new Stack(second, control).capture()).rejects.toThrow("owned by another Stack");
  expect(control.values().join("\n")).not.toContain('"versionId":"worker-version-2"');

  const unknown = new MemoryControl();
  const manifest = manifestOf("repo-1", "runway");
  unknown.inventoryAs(manifest, receiptOf(manifest));
  unknown.object(`${Stack.refPrefix("bucket", "runway-account-1")}unknown.json`, '{"schema":99}');
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

class SyncControl extends MemoryControl {
  readonly removed: StackResource[] = [];
  readonly live = new Map<string, StackResource>();
  #desired: { manifest: StackManifest; receipt: StackReceipt } | undefined;
  #failApply = false;

  desire(manifest: StackManifest, receipt: StackReceipt): void {
    this.#desired = { manifest, receipt };
  }

  failNextApply(): void {
    this.#failApply = true;
  }

  apply(manifest: StackManifest): Promise<void> {
    if (!this.#desired || this.#desired.manifest.generation !== manifest.generation) {
      throw new Error("missing desired Stack application");
    }
    if (this.#failApply) {
      this.#failApply = false;
      throw new Error("partial provider apply");
    }
    const desiredRoutes = new Set(manifest.routes);
    if (
      [...this.live.values()].some(
        (resource) => resource.type === "route" && !desiredRoutes.has(resource.pattern),
      )
    ) {
      throw new Error("stale route reached provider apply");
    }
    this.inventoryAs(manifest, this.#desired.receipt);
    for (const resource of resourcesOf(this.#desired.receipt))
      this.live.set(resourceKey(resource), resource);
    return Promise.resolve();
  }

  deleteResource(resource: StackResource): Promise<void> {
    this.removed.push(structuredClone(resource));
    this.live.delete(resourceKey(resource));
    return Promise.resolve();
  }

  hasResource(resource: StackResource): Promise<boolean> {
    return Promise.resolve(this.live.has(resourceKey(resource)));
  }
}

const resourceKey = (resource: StackResource): string => {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : value;
  return JSON.stringify(canonical(resource));
};

const resourcesOf = (receipt: StackReceipt): readonly StackResource[] => [
  { type: "worker", ...receipt.worker },
  { type: "workflow", ...receipt.workflow, scriptName: receipt.worker.name },
  { type: "container", ...receipt.container },
  ...receipt.namespaces.map(({ id, name, className, scriptName }) => ({
    type: "namespace" as const,
    id,
    name,
    className,
    scriptName,
  })),
  ...receipt.routes.map(({ zoneId, id, pattern }) => ({
    type: "route" as const,
    zoneId,
    id,
    pattern,
  })),
  ...receipt.buckets.flatMap((bucket) => [
    ...(bucket.shared
      ? []
      : [
          {
            type: "bucket" as const,
            name: bucket.name,
            lifecycle: bucket.lifecycle,
            publicAccess: bucket.publicAccess,
            customDomains: bucket.customDomains,
          },
        ]),
    ...bucket.objects
      .filter((object) => !object.shared)
      .map(({ key, digest, etag, version }) => ({
        type: "object" as const,
        bucket: bucket.name,
        key,
        digest,
        etag,
        ...(version ? { version } : {}),
      })),
  ]),
];

test("Stack sync applies and verifies one desired generation and retries a partial application", async () => {
  const control = new SyncControl();
  const manifest = manifestOf("repo-1", "runway");
  const receipt = receiptOf(manifest);
  control.desire(manifest, receipt);
  control.failNextApply();
  const stack = new Stack(manifest, control);

  await expect(stack.sync()).rejects.toThrow("partial provider apply");
  await expect(stack.sync()).resolves.toMatchObject({ receipt, retainedWorkerHistory: [] });
  await expect(stack.read()).resolves.toEqual(receipt);
});

test("Stack sync prunes only exact stale owned resources and reports retained Worker history", async () => {
  const control = new SyncControl();
  const oldManifest = manifestOf("repo-1", "runway");
  const oldReceipt = receiptOf(oldManifest, "old");
  control.inventoryAs(oldManifest, oldReceipt);
  for (const resource of resourcesOf(oldReceipt)) control.live.set(resourceKey(resource), resource);
  await new Stack(oldManifest, control).capture();

  const manifest = manifestOf("repo-1", "runway", {
    generation: digest("9"),
    worker: { name: "runway", moduleDigest: digest("8") },
    schedules: [],
    routes: [],
    buckets: oldManifest.buckets.map((bucket) => ({
      ...bucket,
      objects: bucket.objects.filter(({ shared }) => shared),
    })),
  });
  const receipt = receiptOf(manifest, "new");
  control.desire(manifest, receipt);

  await expect(new Stack(manifest, control).sync()).resolves.toEqual({
    receipt,
    retainedWorkerHistory: [
      {
        name: "runway",
        versionId: "worker-version-old",
        deploymentId: "worker-deployment-old",
      },
    ],
  });
  expect(control.removed).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "route", id: "route-old" }),
      expect.objectContaining({ type: "object", key: "artifacts/repo-1/one" }),
    ]),
  );
  expect(control.removed).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "bucket", name: "runway-account-1" }),
      expect.objectContaining({ type: "object", key: "content/shared" }),
      expect.objectContaining({ type: "workflow", name: "runway" }),
      expect.objectContaining({ type: "container", name: "runway-Sandbox" }),
      expect.objectContaining({ type: "namespace", name: "runway_Sandbox" }),
      expect.objectContaining({ type: "worker" }),
    ]),
  );
  expect(control.values().join("\n")).not.toContain("namespace-RunwaySandbox-old");
});

test("Stack sync separates provider identity from new deletion evidence", async () => {
  const control = new SyncControl();
  const oldManifest = manifestOf("repo-1", "runway");
  const oldReceipt = receiptOf(oldManifest, "old");
  control.inventoryAs(oldManifest, oldReceipt);
  for (const resource of resourcesOf(oldReceipt)) control.live.set(resourceKey(resource), resource);
  await new Stack(oldManifest, control).capture();

  const manifest = { ...oldManifest, generation: digest("9") };
  const receipt = receiptOf(manifest, "new");
  control.desire(manifest, receipt);
  await new Stack(manifest, control).sync();

  expect(control.removed).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "object", key: "artifacts/repo-1/one" }),
      expect.objectContaining({ type: "workflow", name: "runway" }),
      expect.objectContaining({ type: "container", name: "runway-Sandbox" }),
      expect.objectContaining({ type: "namespace", name: "runway_Sandbox" }),
    ]),
  );
});

test("Stack remove verifies ownership, is idempotent, and re-queries exact survivors", async () => {
  const control = new SyncControl();
  const manifest = manifestOf("repo-1", "runway");
  const receipt = receiptOf(manifest);
  control.inventoryAs(manifest, receipt);
  for (const resource of resourcesOf(receipt)) control.live.set(resourceKey(resource), resource);
  const stack = new Stack(manifest, control);
  await stack.capture();

  await expect(stack.remove()).resolves.toEqual({
    retainedWorkerHistory: [
      {
        name: "runway",
        versionId: "worker-version-1",
        deploymentId: "worker-deployment-1",
      },
    ],
  });
  await expect(stack.remove()).resolves.toEqual({ retainedWorkerHistory: [] });
  const survivors: StackResource[] = [];
  for (const resource of resourcesOf(receipt).filter(({ type }) => type !== "worker")) {
    if (await control.hasResource(resource)) survivors.push(resource);
  }
  expect(survivors).toEqual([]);
  await expect(
    control.hasResource(resourcesOf(receipt).find(({ type }) => type === "worker")!),
  ).resolves.toBe(false);
  const types = control.removed.map(({ type }) => type);
  expect(types.indexOf("object")).toBeLessThan(types.indexOf("worker"));
  expect(types.indexOf("container")).toBeLessThan(types.indexOf("namespace"));
  expect(types.indexOf("worker")).toBeLessThan(types.indexOf("namespace"));
  expect(types.indexOf("route")).toBeLessThan(types.indexOf("worker"));
  expect(types.indexOf("workflow")).toBeLessThan(types.indexOf("worker"));
  expect(control.values().join("\n")).not.toContain(`"stackId":"${manifest.owner.stackId}"`);
});
