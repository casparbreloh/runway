import { createHash } from "node:crypto";

import { SECRET_SNAPSHOT_KEY_BINDING } from "../runtime/contract.ts";

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
  readonly schedulingPolicy: string;
  readonly maxInstances: number;
  readonly tiers: readonly string[];
  readonly rolloutActiveGracePeriod: number;
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
    readonly providerEtag: string;
    readonly versionId: string;
    readonly deploymentId: string;
  };
  readonly workflow: StackManifest["workflow"] & { readonly id: string };
  readonly container: StackContainer & {
    readonly id: string;
    readonly rolloutId?: string;
    readonly namespaceId: string;
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
    readonly scriptName: string;
  }[];
}

export interface StackControl {
  inventory(manifest: StackManifest): Promise<StackReceipt>;
  read(key: string): Promise<{ readonly value: string; readonly revision: string } | undefined>;
  list(
    prefix: string,
  ): Promise<
    readonly { readonly key: string; readonly value: string; readonly revision: string }[]
  >;
  writeOnce(key: string, value: string): Promise<void>;
  deleteState(key: string, revision: string): Promise<void>;
  apply(manifest: StackManifest): Promise<void>;
  deleteResource(resource: StackResource): Promise<void>;
  hasResource(resource: StackResource): Promise<boolean>;
}

export type StackResource =
  | {
      readonly type: "worker";
      readonly name: string;
      readonly moduleDigest: string;
      readonly providerEtag: string;
      readonly versionId: string;
      readonly deploymentId: string;
    }
  | {
      readonly type: "workflow";
      readonly name: string;
      readonly id: string;
      readonly className: string;
      readonly scriptName: string;
    }
  | ({ readonly type: "container"; readonly id: string } & StackReceipt["container"])
  | {
      readonly type: "namespace";
      readonly name: string;
      readonly id: string;
      readonly className: string;
      readonly scriptName: string;
    }
  | {
      readonly type: "route";
      readonly zoneId: string;
      readonly id: string;
      readonly pattern: string;
      readonly scriptName: string;
    }
  | {
      readonly type: "bucket";
      readonly name: string;
      readonly lifecycle: string;
      readonly publicAccess: boolean;
      readonly customDomains: readonly string[];
    }
  | {
      readonly type: "object";
      readonly bucket: string;
      readonly key: string;
      readonly digest: string;
      readonly etag: string;
      readonly version?: string;
    };

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

export const stackIdOf = (accountId: string, repositoryId: string, name: string): string => {
  required(accountId, "account identity", 512);
  required(repositoryId, "repository identity", 512);
  required(name, "name", 128);
  return digestOf(["runway-stack-v2", accountId, repositoryId, name]);
};

const assertOwner = (owner: StackOwner): void => {
  assertKeys(owner, ["accountId", "repositoryId", "stackId", "name"], "owner");
  required(owner.accountId, "account identity", 512);
  required(owner.repositoryId, "repository identity", 512);
  required(owner.name, "name", 128);
  sha256(owner.stackId, "stack identity");
  if (owner.stackId !== stackIdOf(owner.accountId, owner.repositoryId, owner.name)) {
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
      "schedulingPolicy",
      "maxInstances",
      "tiers",
      "rolloutActiveGracePeriod",
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
  required(container.schedulingPolicy, "container scheduling policy", 128);
  assertInteger(container.maxInstances, "container max instances");
  assertStrings(container.tiers, "container tiers", 128);
  assertInteger(container.rolloutActiveGracePeriod, "container rollout active grace period");
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
      bucket.lifecycle !== "stack-state" &&
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
    schedulingPolicy: receipt.container.schedulingPolicy,
    maxInstances: receipt.container.maxInstances,
    tiers: receipt.container.tiers,
    rolloutActiveGracePeriod: receipt.container.rolloutActiveGracePeriod,
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
    ["name", "moduleDigest", "providerEtag", "versionId", "deploymentId"],
    "receipt Worker",
  );
  required(receipt.worker.versionId, "Worker version id", 512);
  required(receipt.worker.deploymentId, "Worker deployment id", 512);
  required(receipt.worker.providerEtag, "Worker module etag", 512);
  assertKeys(receipt.workflow, ["name", "className", "id"], "receipt workflow");
  required(receipt.workflow.id, "Dynamic Workflow id", 512);
  assertOptionalKeys(
    receipt.container,
    [
      "name",
      "image",
      "imageDigest",
      "platform",
      "runnerAbi",
      "instanceType",
      "schedulingPolicy",
      "maxInstances",
      "tiers",
      "rolloutActiveGracePeriod",
      "id",
      "namespaceId",
    ],
    ["rolloutId"],
    "receipt container",
  );
  required(receipt.container.id, "container application id", 512);
  if (receipt.container.rolloutId !== undefined) {
    required(receipt.container.rolloutId, "container rollout id", 512);
  }
  required(receipt.container.namespaceId, "container namespace id", 512);
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
    assertKeys(route, ["zoneId", "id", "pattern", "scriptName"], "receipt route");
    required(route.zoneId, "route zone id", 512);
    required(route.id, "route id", 512);
    required(route.pattern, "route pattern", 512);
    required(route.scriptName, "route Worker script", 128);
    if (route.scriptName !== receipt.worker.name) {
      throw new Error("Stack route belongs to another Worker");
    }
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
    const key = Stack.refPrefix(claim.kind, claim.name);
    const existing = unique.get(key);
    if (existing && !same(existing, claim)) throw new Error("Stack ownership claim collision");
    unique.set(key, claim);
  }
  return [...unique.values()].sort((left, right) =>
    order(Stack.refPrefix(left.kind, left.name), Stack.refPrefix(right.kind, right.name)),
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

const resourceKeyOf = (resource: StackResource): string => {
  switch (resource.type) {
    case "worker":
    case "workflow":
    case "container":
    case "namespace":
    case "bucket":
      return canonicalJson({ type: resource.type, name: resource.name });
    case "route":
      return canonicalJson({
        type: resource.type,
        zoneId: resource.zoneId,
        pattern: resource.pattern,
      });
    case "object":
      return canonicalJson({
        type: resource.type,
        bucket: resource.bucket,
        key: resource.key,
      });
  }
};

const resourceOrder = (resource: StackResource): number => {
  switch (resource.type) {
    case "object":
      return 0;
    case "route":
    case "workflow":
      return 1;
    case "container":
      return 2;
    case "worker":
      return 3;
    case "namespace":
      return 4;
    case "bucket":
      return 5;
  }
};

const orderResources = (resources: Iterable<StackResource>): readonly StackResource[] =>
  [...resources].sort(
    (left, right) =>
      resourceOrder(left) - resourceOrder(right) ||
      order(resourceKeyOf(left), resourceKeyOf(right)),
  );

const resourcesOf = (receipt: StackReceipt): readonly StackResource[] => [
  { type: "worker", ...receipt.worker },
  {
    type: "workflow",
    ...receipt.workflow,
    scriptName: receipt.worker.name,
  },
  { type: "container", ...receipt.container },
  ...receipt.namespaces.map(({ id, name, className, scriptName }) => ({
    type: "namespace" as const,
    id,
    name,
    className,
    scriptName,
  })),
  ...receipt.routes.map(({ zoneId, id, pattern, scriptName }) => ({
    type: "route" as const,
    zoneId,
    id,
    pattern,
    scriptName,
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

const manifestClaimsOf = (manifest: StackManifest): readonly OwnershipRef[] => {
  const stackId = manifest.owner.stackId;
  const claims: OwnershipRef[] = [
    exclusive("stack", manifest.owner.name, stackId),
    exclusive("worker", manifest.worker.name, stackId),
    exclusive("workflow", manifest.workflow.name, stackId),
    exclusive("container", manifest.container.name, stackId),
    ...manifest.namespaces.map(({ name }) => exclusive("namespace-name", name, stackId)),
    ...manifest.routes.map((pattern) => exclusive("route-pattern", pattern, stackId)),
  ];
  for (const bucket of manifest.buckets) {
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
  return claims;
};

export class Stack {
  readonly #manifest: StackManifest;
  readonly #control: StackControl;

  constructor(manifest: StackManifest, control: StackControl) {
    assertManifest(manifest);
    this.#manifest = structuredClone(manifest);
    this.#control = control;
  }

  static refPrefix(kind: string, name: string): string {
    required(kind, "ownership kind", 128);
    required(name, "ownership name", 2048);
    return `stack/v2/claims/${digestOf([kind, name]).slice("sha256:".length)}/`;
  }

  static refKey(claim: OwnershipRef): string {
    const identity = claim.shared ? claim.configurationDigest : "exclusive";
    const stackId = claim.shared ? claim.stackIds[0]! : claim.stackId;
    return `${Stack.refPrefix(claim.kind, claim.name)}${stackId}/${identity.slice("sha256:".length)}.json`;
  }

  static receiptPrefix(stackId: string): string {
    return `stack/v2/receipts/${sha256(stackId, "receipt Stack identity").slice("sha256:".length)}/`;
  }

  static receiptKey(stackId: string, generation: string): string {
    return `${Stack.receiptPrefix(stackId)}${sha256(generation, "receipt generation").slice("sha256:".length)}.json`;
  }

  async read(): Promise<StackReceipt | undefined> {
    const stored = await this.#control.read(
      Stack.receiptKey(this.#manifest.owner.stackId, this.#manifest.generation),
    );
    if (!stored) return undefined;
    return validateInventory(this.#manifest, parseReceipt(stored.value));
  }

  async capture(): Promise<StackReceipt> {
    const inventory = validateInventory(
      this.#manifest,
      await this.#control.inventory(this.#manifest),
    );
    const receiptKey = Stack.receiptKey(this.#manifest.owner.stackId, this.#manifest.generation);
    const storedReceipt = await this.#control.read(receiptKey);
    if (storedReceipt && !same(parseReceipt(storedReceipt.value), inventory)) {
      throw new Error("Stack inventory does not match its persisted receipt");
    }

    await this.#publishClaims(claimsOf(this.#manifest, inventory));

    const value = canonicalJson(inventory);
    await this.#control.writeOnce(receiptKey, value);
    const reread = await this.read();
    if (!reread || !same(reread, inventory)) throw new Error("Stack receipt persistence failed");
    return reread;
  }

  async sync(): Promise<{
    readonly receipt: StackReceipt;
    readonly retainedWorkerHistory: readonly {
      readonly name: string;
      readonly versionId: string;
      readonly deploymentId: string;
    }[];
  }> {
    await this.#publishClaims(manifestClaimsOf(this.#manifest));
    const previous = await this.#receipts();
    const desiredRoutePatterns = new Set(this.#manifest.routes);
    for (const stored of previous) {
      await this.#verifyClaims(claimsOf(manifestOf(stored.receipt), stored.receipt));
      for (const route of resourcesOf(stored.receipt)) {
        if (route.type === "route" && !desiredRoutePatterns.has(route.pattern)) {
          await this.#deleteAndVerify(route);
        }
      }
    }
    await this.#control.apply(this.#manifest);
    const receipt = await this.capture();
    const desired = new Set(resourcesOf(receipt).map(resourceKeyOf));
    const desiredClaims = [
      ...manifestClaimsOf(this.#manifest),
      ...claimsOf(this.#manifest, receipt),
    ];
    const desiredClaimKeys = new Set(desiredClaims.map((claim) => Stack.refKey(claim)));
    const retainedWorkerHistory: {
      name: string;
      versionId: string;
      deploymentId: string;
    }[] = [];
    for (const stored of previous) {
      if (stored.receipt.generation === receipt.generation) continue;
      await this.#verifyClaims(claimsOf(manifestOf(stored.receipt), stored.receipt));
      if (stored.receipt.worker.name === receipt.worker.name) {
        retainedWorkerHistory.push({
          name: stored.receipt.worker.name,
          versionId: stored.receipt.worker.versionId,
          deploymentId: stored.receipt.worker.deploymentId,
        });
      }
      for (const resource of orderResources(resourcesOf(stored.receipt))) {
        if (
          desired.has(resourceKeyOf(resource)) ||
          (resource.type === "worker" && resource.name === receipt.worker.name)
        ) {
          continue;
        }
        await this.#deleteAndVerify(resource);
      }
      await this.#deleteState(stored.key, stored.revision);
      const oldClaims = [
        ...manifestClaimsOf(manifestOf(stored.receipt)),
        ...claimsOf(manifestOf(stored.receipt), stored.receipt),
      ];
      for (const claim of oldClaims) {
        if (!desiredClaimKeys.has(Stack.refKey(claim))) await this.#deleteClaim(claim);
      }
    }
    return { receipt, retainedWorkerHistory };
  }

  async remove(): Promise<{
    readonly retainedWorkerHistory: readonly {
      readonly name: string;
      readonly versionId: string;
      readonly deploymentId: string;
    }[];
  }> {
    const stored = await this.#receipts();
    if (stored.length === 0) return { retainedWorkerHistory: [] };
    const resources = new Map<string, StackResource>();
    const retainedWorkerHistory = stored.map(({ receipt }) => ({
      name: receipt.worker.name,
      versionId: receipt.worker.versionId,
      deploymentId: receipt.worker.deploymentId,
    }));
    for (const entry of stored) {
      await this.#verifyClaims(claimsOf(manifestOf(entry.receipt), entry.receipt));
      for (const resource of resourcesOf(entry.receipt))
        resources.set(resourceKeyOf(resource), resource);
    }
    const claims = new Map<string, OwnershipRef>();
    for (const entry of stored) {
      for (const claim of [
        ...manifestClaimsOf(manifestOf(entry.receipt)),
        ...claimsOf(manifestOf(entry.receipt), entry.receipt),
      ]) {
        claims.set(Stack.refKey(claim), claim);
      }
    }
    const ordered = orderResources(resources.values());
    for (const resource of ordered) await this.#deleteAndVerify(resource);
    for (const entry of stored) await this.#deleteState(entry.key, entry.revision);
    for (const claim of claims.values()) await this.#deleteClaim(claim);
    return { retainedWorkerHistory };
  }

  async #publishClaims(claims: readonly OwnershipRef[]): Promise<void> {
    await Promise.all(
      claims.map(async (claim) => {
        await this.#control.writeOnce(Stack.refKey(claim), canonicalJson(claim));
      }),
    );
    await this.#verifyClaims(claims);
  }

  async #verifyClaims(claims: readonly OwnershipRef[]): Promise<void> {
    await Promise.all(
      claims.map(async (claim) => {
        const records = await this.#control.list(Stack.refPrefix(claim.kind, claim.name));
        if (!records.some(({ value }) => value === canonicalJson(claim))) {
          throw new Error("Stack ownership claim persistence failed");
        }
        for (const record of records) mergeClaim(claim, ownershipRefOf(record.value));
      }),
    );
  }

  async #receipts(): Promise<
    readonly {
      readonly key: string;
      readonly revision: string;
      readonly receipt: StackReceipt;
    }[]
  > {
    const records = await this.#control.list(Stack.receiptPrefix(this.#manifest.owner.stackId));
    return records.map(({ key, revision, value }) => {
      const receipt = parseReceipt(value);
      if (!same(receipt.owner, this.#manifest.owner)) {
        throw new Error("persisted Stack receipt belongs to another owner");
      }
      return { key, revision, receipt };
    });
  }

  async #deleteAndVerify(resource: StackResource): Promise<void> {
    await this.#control.deleteResource(resource);
    if (await this.#control.hasResource(resource)) {
      throw new Error(`Stack resource survived deletion: ${resource.type}`);
    }
  }

  async #deleteClaim(claim: OwnershipRef): Promise<void> {
    const key = Stack.refKey(claim);
    const stored = await this.#control.read(key);
    if (!stored) return;
    if (stored.value !== canonicalJson(claim)) throw new Error("Stack ownership claim changed");
    await this.#deleteState(key, stored.revision);
  }

  async #deleteState(key: string, revision: string): Promise<void> {
    await this.#control.deleteState(key, revision);
    if (await this.#control.read(key)) throw new Error("Stack state survived deletion");
  }
}
