import { createHash } from "node:crypto";

import { SECRET_SNAPSHOT_KEY_BINDING } from "./worker-contract.ts";

export interface StackOwner {
  readonly accountId: string;
  readonly repositoryId: string;
  readonly stackId: string;
  readonly name: string;
}

export interface StackBinding {
  readonly name: string;
  readonly type: string;
  readonly target?: string;
}

export interface StackObject {
  readonly key: string;
  readonly shared: boolean;
  readonly digest: string;
}

export interface StackBucket {
  readonly name: string;
  readonly shared: boolean;
  readonly lifecycle: string;
  readonly publicAccess: boolean;
  readonly customDomains: readonly string[];
  readonly objects: readonly StackObject[];
}

export interface StackReceiptBucket extends Omit<StackBucket, "objects"> {
  readonly objects: readonly (StackObject & {
    readonly etag: string;
    readonly version?: string;
  })[];
}

interface StackContainer {
  readonly name: string;
  readonly image: string;
  readonly imageDigest: string;
  readonly platform: { readonly os: string; readonly architecture: string };
  readonly runnerAbi: string;
  readonly instanceType: string;
  readonly maxInstances: number;
  readonly tiers: readonly string[];
}

interface StackSnapshotOwnership {
  readonly binding: string;
  readonly ownedKeyBindings: readonly string[];
}

export interface StackManifest {
  readonly owner: StackOwner;
  readonly generation: string;
  readonly worker: { readonly name: string; readonly moduleDigest: string };
  readonly workflow: { readonly name: string; readonly className: string };
  readonly container: StackContainer;
  readonly namespaces: readonly {
    readonly binding: string;
    readonly className: string;
    readonly name: string;
  }[];
  readonly schedules: readonly string[];
  readonly workersDev: boolean;
  readonly routes: readonly string[];
  readonly bindings: readonly StackBinding[];
  readonly secretNames: readonly string[];
  readonly secretSnapshot: StackSnapshotOwnership;
  readonly buckets: readonly StackBucket[];
}

export interface StackReceipt {
  readonly owner: StackOwner;
  readonly generation: string;
  readonly worker: StackManifest["worker"] & {
    readonly versionId: string;
    readonly deploymentId: string;
  };
  readonly workflow: StackManifest["workflow"] & { readonly id: string };
  readonly container: StackContainer & {
    readonly id: string;
    readonly rolloutId: string;
  };
  readonly namespaces: readonly {
    readonly binding: string;
    readonly name: string;
    readonly id: string;
    readonly className: string;
    readonly scriptName: string;
  }[];
  readonly schedules: readonly string[];
  readonly workersDev: boolean;
  readonly bindings: readonly StackBinding[];
  readonly secretNames: readonly string[];
  readonly secretSnapshot: StackSnapshotOwnership;
  readonly buckets: readonly StackReceiptBucket[];
  readonly routes: readonly {
    readonly zoneId: string;
    readonly id: string;
    readonly pattern: string;
  }[];
}

export interface StackControl {
  inventory(manifest: StackManifest): Promise<StackReceipt>;
  read(key: string): Promise<{ readonly value: string; readonly revision: string } | undefined>;
  compareAndSwap(key: string, revision: string | undefined, value: string): Promise<boolean>;
}

interface ExclusiveRef {
  readonly schema: 1;
  readonly kind: string;
  readonly name: string;
  readonly shared: false;
  readonly stackId: string;
}

interface SharedRef {
  readonly schema: 1;
  readonly kind: string;
  readonly name: string;
  readonly shared: true;
  readonly configurationDigest: string;
  readonly stackIds: readonly string[];
}

type OwnershipRef = ExclusiveRef | SharedRef;
type RecordValue = Record<string, unknown>;

const utf8 = new TextEncoder();
const keys = (value: object): string => Object.keys(value).sort().join(",");
const order = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const required = (value: unknown, field: string, maxBytes = 16 * 1024): string => {
  if (
    typeof value !== "string" ||
    utf8.encode(value).byteLength === 0 ||
    utf8.encode(value).byteLength > maxBytes
  ) {
    throw new Error(`invalid Stack ${field}`);
  }
  return value;
};

const sha256 = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`invalid Stack ${field}`);
  }
  return value;
};

const assertKeys = (value: unknown, expected: readonly string[], field: string): RecordValue => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    keys(value) !== [...expected].sort().join(",")
  ) {
    throw new Error(`invalid Stack ${field}`);
  }
  return value as RecordValue;
};

const assertOptionalKeys = (
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  field: string,
): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid Stack ${field}`);
  }
  const actual = Object.keys(value);
  if (
    requiredKeys.some((key) => !actual.includes(key)) ||
    actual.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))
  ) {
    throw new Error(`invalid Stack ${field}`);
  }
  return value as RecordValue;
};

const assertSorted = (values: readonly string[], field: string): void => {
  if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) {
    throw new Error(`Stack ${field} must be sorted and unique`);
  }
};

const assertStrings = (value: unknown, field: string, maxBytes = 16 * 1024): readonly string[] => {
  if (!Array.isArray(value)) throw new Error(`invalid Stack ${field}`);
  const values = value.map((entry) => required(entry, field, maxBytes));
  assertSorted(values, field);
  return values;
};

const assertInteger = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`invalid Stack ${field}`);
  }
  return value as number;
};

const assertBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`invalid Stack ${field}`);
  return value;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return String(assertInteger(value, "integer"));
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as RecordValue)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => order(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("invalid Stack value");
};

const digestOf = (values: readonly string[]): string => {
  const hash = createHash("sha256");
  for (const value of values) {
    const bytes = utf8.encode(value);
    const size = Buffer.allocUnsafe(4);
    size.writeUInt32BE(bytes.byteLength);
    hash.update(size);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
};

export const stackIdOf = (accountId: string, repositoryId: string): string => {
  required(accountId, "account identity", 512);
  required(repositoryId, "repository identity", 512);
  return digestOf(["runway-stack-v1", accountId, repositoryId]);
};

const assertOwner = (owner: StackOwner): void => {
  assertKeys(owner, ["accountId", "repositoryId", "stackId", "name"], "owner");
  required(owner.accountId, "account identity", 512);
  required(owner.repositoryId, "repository identity", 512);
  required(owner.name, "name", 128);
  sha256(owner.stackId, "stack identity");
  if (owner.stackId !== stackIdOf(owner.accountId, owner.repositoryId)) {
    throw new Error("invalid Stack owner identity");
  }
};

const assertBindings = (bindings: readonly StackBinding[]): void => {
  if (!Array.isArray(bindings)) throw new Error("invalid Stack bindings");
  for (const binding of bindings) {
    assertOptionalKeys(binding, ["name", "type"], ["target"], "binding");
    required(binding.name, "binding name", 128);
    required(binding.type, "binding type", 128);
    if (binding.target !== undefined) required(binding.target, "binding target", 512);
  }
  assertSorted(
    bindings.map(({ name }) => name),
    "bindings",
  );
};

const assertContainer = (container: StackContainer): void => {
  assertKeys(
    container,
    [
      "name",
      "image",
      "imageDigest",
      "platform",
      "runnerAbi",
      "instanceType",
      "maxInstances",
      "tiers",
    ],
    "container",
  );
  required(container.name, "container name", 128);
  const imageDigest = sha256(container.imageDigest, "container image digest");
  const image = required(container.image, "digest-pinned container image", 1024);
  if (
    !/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(image) ||
    !image.endsWith(`@${imageDigest}`)
  ) {
    throw new Error("invalid Stack digest-pinned container image");
  }
  assertKeys(container.platform, ["os", "architecture"], "container platform");
  required(container.platform.os, "container operating system", 128);
  required(container.platform.architecture, "container architecture", 128);
  required(container.runnerAbi, "runner ABI", 128);
  required(container.instanceType, "container instance type", 128);
  assertInteger(container.maxInstances, "container max instances");
  assertStrings(container.tiers, "container tiers", 128);
};

const assertBuckets = (buckets: readonly StackBucket[], receipt: boolean): void => {
  if (!Array.isArray(buckets)) throw new Error("invalid Stack buckets");
  for (const bucket of buckets) {
    assertKeys(
      bucket,
      ["name", "shared", "lifecycle", "publicAccess", "customDomains", "objects"],
      "bucket",
    );
    required(bucket.name, "bucket name", 128);
    assertBoolean(bucket.shared, "bucket sharing");
    required(bucket.lifecycle, "bucket lifecycle");
    assertBoolean(bucket.publicAccess, "bucket public access");
    assertStrings(bucket.customDomains, "bucket custom domains", 512);
    if (!Array.isArray(bucket.objects)) throw new Error("invalid Stack bucket objects");
    for (const object of bucket.objects) {
      if (receipt) {
        assertOptionalKeys(
          object,
          ["key", "shared", "digest", "etag"],
          ["version"],
          "receipt bucket object",
        );
        required((object as StackReceiptBucket["objects"][number]).etag, "object etag", 512);
        const version = (object as StackReceiptBucket["objects"][number]).version;
        if (version !== undefined) required(version, "object version", 512);
      } else {
        assertKeys(object, ["key", "shared", "digest"], "bucket object");
      }
      required(object.key, "bucket object key", 1024);
      assertBoolean(object.shared, "bucket object sharing");
      sha256(object.digest, "bucket object digest");
    }
    assertSorted(
      bucket.objects.map((object: StackObject) => object.key),
      "bucket objects",
    );
  }
  assertSorted(
    buckets.map(({ name }) => name),
    "buckets",
  );
};

const assertManifest = (manifest: StackManifest): void => {
  assertKeys(
    manifest,
    [
      "owner",
      "generation",
      "worker",
      "workflow",
      "container",
      "namespaces",
      "schedules",
      "workersDev",
      "routes",
      "bindings",
      "secretNames",
      "secretSnapshot",
      "buckets",
    ],
    "manifest",
  );
  assertOwner(manifest.owner);
  sha256(manifest.generation, "generation");
  assertKeys(manifest.worker, ["name", "moduleDigest"], "Worker");
  required(manifest.worker.name, "Worker name", 128);
  sha256(manifest.worker.moduleDigest, "Worker module digest");
  assertKeys(manifest.workflow, ["name", "className"], "Dynamic Workflow");
  required(manifest.workflow.name, "workflow name", 128);
  required(manifest.workflow.className, "workflow class", 128);
  assertContainer(manifest.container);
  if (!Array.isArray(manifest.namespaces)) throw new Error("invalid Stack namespaces");
  for (const namespace of manifest.namespaces) {
    assertKeys(namespace, ["binding", "className", "name"], "namespace");
    required(namespace.binding, "namespace binding", 128);
    required(namespace.className, "namespace class", 128);
    required(namespace.name, "namespace name", 128);
  }
  assertSorted(
    manifest.namespaces.map(({ binding }) => binding),
    "namespaces",
  );
  assertStrings(manifest.schedules, "schedules", 512);
  assertBoolean(manifest.workersDev, "workers.dev state");
  assertStrings(manifest.routes, "routes", 512);
  assertBindings(manifest.bindings);
  assertStrings(manifest.secretNames, "secret names", 128);
  assertKeys(manifest.secretSnapshot, ["binding", "ownedKeyBindings"], "secret snapshot");
  assertStrings(manifest.secretSnapshot.ownedKeyBindings, "snapshot key bindings", 128);
  assertBuckets(manifest.buckets, false);
  if (
    manifest.secretSnapshot.binding !== SECRET_SNAPSHOT_KEY_BINDING ||
    !manifest.secretNames.includes(manifest.secretSnapshot.binding) ||
    manifest.secretSnapshot.ownedKeyBindings.some(
      (name) =>
        !name.startsWith(`${SECRET_SNAPSHOT_KEY_BINDING}_`) || !manifest.secretNames.includes(name),
    ) ||
    manifest.secretNames.some(
      (name) =>
        name.startsWith(`${SECRET_SNAPSHOT_KEY_BINDING}_`) &&
        !manifest.secretSnapshot.ownedKeyBindings.includes(name),
    )
  ) {
    throw new Error("invalid Stack secret snapshot ownership");
  }
  if (!manifest.bindings.some(({ type }) => type === "worker_loader")) {
    throw new Error("Stack has no Worker Loader binding");
  }
  if (
    !manifest.bindings.some(
      ({ type, target }) => type === "workflow" && target === manifest.workflow.name,
    )
  ) {
    throw new Error("Stack has no Dynamic Workflow binding");
  }
  for (const bucket of manifest.buckets) {
    if (
      !manifest.bindings.some(({ type, target }) => type === "r2_bucket" && target === bucket.name)
    ) {
      throw new Error(`Stack has no R2 binding for ${bucket.name}`);
    }
  }
  for (const namespace of manifest.namespaces) {
    if (
      !manifest.bindings.some(
        ({ name, type, target }) =>
          name === namespace.binding &&
          type === "durable_object_namespace" &&
          target === namespace.className,
      )
    ) {
      throw new Error(`Stack has no Durable Object binding for ${namespace.binding}`);
    }
  }
};

const manifestOf = (receipt: StackReceipt): StackManifest => ({
  owner: receipt.owner,
  generation: receipt.generation,
  worker: { name: receipt.worker.name, moduleDigest: receipt.worker.moduleDigest },
  workflow: { name: receipt.workflow.name, className: receipt.workflow.className },
  container: {
    name: receipt.container.name,
    image: receipt.container.image,
    imageDigest: receipt.container.imageDigest,
    platform: receipt.container.platform,
    runnerAbi: receipt.container.runnerAbi,
    instanceType: receipt.container.instanceType,
    maxInstances: receipt.container.maxInstances,
    tiers: receipt.container.tiers,
  },
  namespaces: receipt.namespaces.map(({ binding, className, name }) => ({
    binding,
    className,
    name,
  })),
  schedules: receipt.schedules,
  workersDev: receipt.workersDev,
  routes: receipt.routes.map(({ pattern }) => pattern),
  bindings: receipt.bindings,
  secretNames: receipt.secretNames,
  secretSnapshot: receipt.secretSnapshot,
  buckets: receipt.buckets.map((bucket) => ({
    ...bucket,
    objects: bucket.objects.map(({ key, shared, digest }) => ({ key, shared, digest })),
  })),
});

const assertReceipt = (receipt: StackReceipt): void => {
  assertKeys(
    receipt,
    [
      "owner",
      "generation",
      "worker",
      "workflow",
      "container",
      "namespaces",
      "schedules",
      "workersDev",
      "bindings",
      "secretNames",
      "secretSnapshot",
      "buckets",
      "routes",
    ],
    "receipt",
  );
  assertKeys(
    receipt.worker,
    ["name", "moduleDigest", "versionId", "deploymentId"],
    "receipt Worker",
  );
  required(receipt.worker.versionId, "Worker version id", 512);
  required(receipt.worker.deploymentId, "Worker deployment id", 512);
  assertKeys(receipt.workflow, ["name", "className", "id"], "receipt workflow");
  required(receipt.workflow.id, "Dynamic Workflow id", 512);
  assertKeys(
    receipt.container,
    [
      "name",
      "image",
      "imageDigest",
      "platform",
      "runnerAbi",
      "instanceType",
      "maxInstances",
      "tiers",
      "id",
      "rolloutId",
    ],
    "receipt container",
  );
  required(receipt.container.id, "container application id", 512);
  required(receipt.container.rolloutId, "container rollout id", 512);
  if (!Array.isArray(receipt.namespaces)) throw new Error("invalid Stack receipt namespaces");
  for (const namespace of receipt.namespaces) {
    assertKeys(
      namespace,
      ["binding", "name", "id", "className", "scriptName"],
      "receipt namespace",
    );
    required(namespace.id, "namespace id", 512);
    if (namespace.scriptName !== receipt.worker.name) {
      throw new Error("Stack namespace belongs to another Worker");
    }
  }
  assertSorted(
    receipt.namespaces.map(({ binding }) => binding),
    "receipt namespaces",
  );
  assertBuckets(receipt.buckets, true);
  if (!Array.isArray(receipt.routes)) throw new Error("invalid Stack receipt routes");
  for (const route of receipt.routes) {
    assertKeys(route, ["zoneId", "id", "pattern"], "receipt route");
    required(route.zoneId, "route zone id", 512);
    required(route.id, "route id", 512);
    required(route.pattern, "route pattern", 512);
  }
  assertSorted(
    receipt.routes.map(({ pattern }) => pattern),
    "receipt routes",
  );
  assertManifest(manifestOf(receipt));
};

const same = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

const validateInventory = (manifest: StackManifest, receipt: StackReceipt): StackReceipt => {
  assertManifest(manifest);
  assertReceipt(receipt);
  if (!same(manifestOf(receipt), manifest))
    throw new Error("Stack inventory does not match manifest");
  return receipt;
};

const parseReceipt = (value: string): StackReceipt => {
  let receipt: StackReceipt;
  try {
    receipt = JSON.parse(value) as StackReceipt;
    assertReceipt(receipt);
  } catch {
    throw new Error("invalid persisted Stack ownership");
  }
  if (canonicalJson(receipt) !== value) throw new Error("invalid persisted Stack ownership");
  return receipt;
};

const ownershipRefOf = (value: string): OwnershipRef => {
  let raw: RecordValue;
  try {
    raw = JSON.parse(value) as RecordValue;
    if (raw.shared === false) {
      assertKeys(raw, ["schema", "kind", "name", "shared", "stackId"], "ownership ref");
      if (raw.schema !== 1) throw new Error();
      const ref: ExclusiveRef = {
        schema: 1,
        kind: required(raw.kind, "ownership kind", 128),
        name: required(raw.name, "ownership name", 2048),
        shared: false,
        stackId: sha256(raw.stackId, "ownership stack id"),
      };
      if (canonicalJson(ref) !== value) throw new Error();
      return ref;
    }
    assertKeys(
      raw,
      ["schema", "kind", "name", "shared", "configurationDigest", "stackIds"],
      "ownership ref",
    );
    if (raw.schema !== 1 || raw.shared !== true) throw new Error();
    const ref: SharedRef = {
      schema: 1,
      kind: required(raw.kind, "ownership kind", 128),
      name: required(raw.name, "ownership name", 2048),
      shared: true,
      configurationDigest: sha256(raw.configurationDigest, "shared configuration digest"),
      stackIds: assertStrings(raw.stackIds, "shared Stack identities", 128).map((stackId) =>
        sha256(stackId, "shared Stack identity"),
      ),
    };
    if (canonicalJson(ref) !== value) throw new Error();
    return ref;
  } catch {
    throw new Error("invalid persisted Stack ownership");
  }
};

const exclusive = (kind: string, name: string, stackId: string): ExclusiveRef => ({
  schema: 1,
  kind,
  name,
  shared: false,
  stackId,
});

const shared = (
  kind: string,
  name: string,
  configuration: unknown,
  stackId: string,
): SharedRef => ({
  schema: 1,
  kind,
  name,
  shared: true,
  configurationDigest: digestOf([canonicalJson(configuration)]),
  stackIds: [stackId],
});

const claimsOf = (manifest: StackManifest, receipt: StackReceipt): readonly OwnershipRef[] => {
  const stackId = manifest.owner.stackId;
  const claims: OwnershipRef[] = [
    exclusive("stack", manifest.owner.name, stackId),
    exclusive("worker", receipt.worker.name, stackId),
    exclusive("workflow", receipt.workflow.name, stackId),
    exclusive("container", receipt.container.name, stackId),
    ...receipt.namespaces.flatMap(({ id, name }) => [
      exclusive("namespace", id, stackId),
      exclusive("namespace-name", name, stackId),
    ]),
    ...receipt.routes.map(({ zoneId, pattern }) =>
      exclusive("route", canonicalJson([zoneId, pattern]), stackId),
    ),
  ];
  for (const bucket of receipt.buckets) {
    claims.push(
      bucket.shared
        ? shared(
            "bucket",
            bucket.name,
            {
              lifecycle: bucket.lifecycle,
              publicAccess: bucket.publicAccess,
              customDomains: bucket.customDomains,
            },
            stackId,
          )
        : exclusive("bucket", bucket.name, stackId),
    );
    for (const object of bucket.objects) {
      const name = canonicalJson([bucket.name, object.key]);
      claims.push(
        object.shared
          ? shared(
              "object",
              name,
              { bucket: bucket.name, key: object.key, digest: object.digest },
              stackId,
            )
          : exclusive("object", name, stackId),
      );
    }
  }
  const unique = new Map<string, OwnershipRef>();
  for (const claim of claims) {
    const key = Stack.refKey(claim.kind, claim.name);
    const existing = unique.get(key);
    if (existing && !same(existing, claim)) throw new Error("Stack ownership claim collision");
    unique.set(key, claim);
  }
  return [...unique.values()].sort((left, right) =>
    order(Stack.refKey(left.kind, left.name), Stack.refKey(right.kind, right.name)),
  );
};

const mergeClaim = (claim: OwnershipRef, existing: OwnershipRef | undefined): OwnershipRef => {
  if (!existing) return claim;
  if (
    claim.kind !== existing.kind ||
    claim.name !== existing.name ||
    claim.shared !== existing.shared
  ) {
    throw new Error(`${claim.kind} ${claim.name} is owned by another Stack`);
  }
  if (!claim.shared) {
    if (existing.shared || claim.stackId !== existing.stackId) {
      throw new Error(`${claim.kind} ${claim.name} is owned by another Stack`);
    }
    return existing;
  }
  if (!existing.shared) throw new Error(`${claim.kind} ${claim.name} is owned by another Stack`);
  if (claim.configurationDigest !== existing.configurationDigest) {
    throw new Error(`${claim.kind} ${claim.name} has incompatible shared Stack state`);
  }
  return { ...existing, stackIds: [...new Set([...existing.stackIds, ...claim.stackIds])].sort() };
};

export class Stack {
  readonly #manifest: StackManifest;
  readonly #control: StackControl;

  constructor(manifest: StackManifest, control: StackControl) {
    assertManifest(manifest);
    this.#manifest = structuredClone(manifest);
    this.#control = control;
  }

  static refKey(kind: string, name: string): string {
    required(kind, "ownership kind", 128);
    required(name, "ownership name", 2048);
    return `stack/v1/refs/${digestOf([kind, name]).slice("sha256:".length)}.json`;
  }

  static receiptKey(stackId: string): string {
    return `stack/v1/receipts/${sha256(stackId, "receipt Stack identity").slice("sha256:".length)}.json`;
  }

  async read(): Promise<StackReceipt | undefined> {
    const stored = await this.#control.read(Stack.receiptKey(this.#manifest.owner.stackId));
    if (!stored) return undefined;
    return validateInventory(this.#manifest, parseReceipt(stored.value));
  }

  async capture(): Promise<StackReceipt> {
    const inventory = validateInventory(
      this.#manifest,
      await this.#control.inventory(this.#manifest),
    );
    const receiptKey = Stack.receiptKey(this.#manifest.owner.stackId);
    const storedReceipt = await this.#control.read(receiptKey);
    if (storedReceipt && !same(parseReceipt(storedReceipt.value), inventory)) {
      throw new Error("Stack inventory does not match its persisted receipt");
    }

    const claims = await Promise.all(
      claimsOf(this.#manifest, inventory).map(async (claim) => {
        const key = Stack.refKey(claim.kind, claim.name);
        const observed = await this.#control.read(key);
        const existing = observed ? ownershipRefOf(observed.value) : undefined;
        return { claim, key, observed, desired: mergeClaim(claim, existing) };
      }),
    );
    for (const { claim, key, observed, desired } of claims) {
      const value = canonicalJson(desired);
      if (observed?.value === value) continue;
      if (!(await this.#control.compareAndSwap(key, observed?.revision, value))) {
        const winner = await this.#control.read(key);
        if (!winner) throw new Error("Stack ownership changed concurrently");
        const parsed = ownershipRefOf(winner.value);
        if (!same(parsed, mergeClaim(claim, parsed))) {
          throw new Error("Stack ownership changed concurrently");
        }
      }
    }

    const value = canonicalJson(inventory);
    if (!storedReceipt && !(await this.#control.compareAndSwap(receiptKey, undefined, value))) {
      const winner = await this.#control.read(receiptKey);
      if (!winner || winner.value !== value) throw new Error("Stack receipt changed concurrently");
    }
    const reread = await this.read();
    if (!reread || !same(reread, inventory)) throw new Error("Stack receipt persistence failed");
    return reread;
  }
}
