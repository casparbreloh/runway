import { stackIdOf } from "./stack.ts";
import { SECRET_SNAPSHOT_KEY_BINDING } from "./worker-contract.ts";

interface LegacyObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
}

interface LegacyBucketState {
  readonly location: string;
  readonly storageClass: string;
  readonly jurisdiction: string;
  readonly lifecycle: string;
  readonly publicAccess: boolean;
  readonly managedDomain: string;
  readonly customDomains: readonly string[];
  readonly cors: boolean;
}

export interface LegacyStackReceipt {
  readonly schema: 1;
  readonly authority: "delete-only";
  readonly owner: {
    readonly accountId: string;
    readonly repositoryId: string;
    readonly stackId: string;
  };
  readonly worker: {
    readonly name: string;
    readonly versionId: string;
    readonly deploymentId: string;
    readonly retainedVersionIds: readonly string[];
    readonly retainedDeploymentIds: readonly string[];
  };
  readonly workflow: {
    readonly name: string;
    readonly id: string;
    readonly className: string;
    readonly scriptName: string;
    readonly versionId: string;
    readonly retainedVersionIds: readonly string[];
  };
  readonly container: {
    readonly name: string;
    readonly id: string;
    readonly rolloutId: string;
    readonly imageTag: string;
    readonly resolvedImageDigest: string;
    readonly platform: { readonly os: "linux"; readonly architecture: "amd64" };
    readonly version: number;
    readonly schedulingPolicy: string;
    readonly maxInstances: number;
    readonly rolloutActiveGracePeriod: number;
    readonly tiers: readonly string[];
    readonly namespaceId: string;
    readonly configuration: {
      readonly vcpu: number;
      readonly memoryMiB: number;
      readonly diskSizeMb: number;
      readonly runtime: string;
      readonly networkMode: string;
      readonly assignIpv4: string;
      readonly assignIpv6: string;
      readonly bandwidthLimitMbps: number;
      readonly command: readonly string[];
      readonly entrypoint: readonly string[];
    };
    readonly rollouts: readonly {
      readonly id: string;
      readonly status: string;
      readonly currentVersion: number;
      readonly targetVersion: number;
    }[];
  };
  readonly namespaces: readonly {
    readonly binding: string;
    readonly name: string;
    readonly className: string;
    readonly id: string;
    readonly scriptName: string;
  }[];
  readonly bindings: readonly {
    readonly name: string;
    readonly type: string;
    readonly target?: string;
  }[];
  readonly secretNames: readonly string[];
  readonly schedules: readonly string[];
  readonly workersDev: { readonly enabled: boolean; readonly previewsEnabled: boolean };
  readonly routes: readonly {
    readonly zoneId: string;
    readonly id: string;
    readonly pattern: string;
  }[];
  readonly secretSnapshot: {
    readonly binding: typeof SECRET_SNAPSHOT_KEY_BINDING;
    readonly ownedKeyBindings: readonly string[];
    readonly status: "runway-prefix-current-target-unverifiable";
    readonly disposition: "prune-after-successful-replacement";
  };
  readonly buckets: readonly (
    | ({
        readonly name: string;
        readonly authority: "preserve-only";
        readonly objectCount: number;
      } & LegacyBucketState)
    | ({
        readonly name: string;
        readonly authority: "delete-after-replacement";
        readonly objects: readonly LegacyObject[];
      } & LegacyBucketState)
  )[];
}

export interface LegacyStackControl {
  inventory(): Promise<LegacyStackReceipt>;
  resolveImageDigest(
    imageTag: string,
    platform: LegacyStackReceipt["container"]["platform"],
  ): Promise<string>;
  read(): Promise<string | undefined>;
  writeOnce(value: string): Promise<void>;
}

const canonical = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && !Object.is(value, -0))
    return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  throw new Error("invalid legacy Stack value");
};

const sortedUnique = (values: readonly string[]): boolean =>
  values.every((value, index) => index === 0 || value > values[index - 1]!);

const assertReceipt = (receipt: LegacyStackReceipt): void => {
  if (
    receipt.schema !== 1 ||
    receipt.authority !== "delete-only" ||
    receipt.owner.stackId !== stackIdOf(receipt.owner.accountId, receipt.owner.repositoryId) ||
    receipt.container.platform.os !== "linux" ||
    receipt.container.platform.architecture !== "amd64" ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.container.resolvedImageDigest) ||
    receipt.container.imageTag.includes("@") ||
    receipt.secretSnapshot.binding !== SECRET_SNAPSHOT_KEY_BINDING ||
    receipt.secretSnapshot.status !== "runway-prefix-current-target-unverifiable" ||
    receipt.secretSnapshot.disposition !== "prune-after-successful-replacement"
  ) {
    throw new Error("invalid legacy Stack receipt");
  }
  const strings = [
    receipt.owner.accountId,
    receipt.owner.repositoryId,
    receipt.worker.name,
    receipt.worker.versionId,
    receipt.worker.deploymentId,
    receipt.workflow.name,
    receipt.workflow.id,
    receipt.workflow.className,
    receipt.workflow.scriptName,
    receipt.workflow.versionId,
    ...receipt.workflow.retainedVersionIds,
    receipt.container.name,
    receipt.container.id,
    receipt.container.rolloutId,
    receipt.container.imageTag,
    receipt.container.schedulingPolicy,
    receipt.container.namespaceId,
    receipt.container.configuration.runtime,
    receipt.container.configuration.networkMode,
    receipt.container.configuration.assignIpv4,
    receipt.container.configuration.assignIpv6,
    ...receipt.container.tiers,
    ...receipt.container.configuration.command,
    ...receipt.container.configuration.entrypoint,
    ...receipt.container.rollouts.flatMap(({ id, status }) => [id, status]),
    ...receipt.worker.retainedVersionIds,
    ...receipt.worker.retainedDeploymentIds,
    ...receipt.namespaces.flatMap(({ binding, name, className, id, scriptName }) => [
      binding,
      name,
      className,
      id,
      scriptName,
    ]),
    ...receipt.bindings.flatMap(({ name, type, target }) => [
      name,
      type,
      ...(target ? [target] : []),
    ]),
    ...receipt.secretNames,
    ...receipt.schedules,
    ...receipt.routes.flatMap(({ zoneId, id, pattern }) => [zoneId, id, pattern]),
    ...receipt.secretSnapshot.ownedKeyBindings,
    ...receipt.buckets.flatMap((bucket) => [
      bucket.name,
      bucket.location,
      bucket.storageClass,
      bucket.jurisdiction,
      bucket.lifecycle,
      bucket.managedDomain,
      ...bucket.customDomains,
      ...(bucket.authority === "delete-after-replacement"
        ? bucket.objects.flatMap(({ key, etag }) => [key, etag])
        : []),
    ]),
  ];
  if (strings.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("invalid legacy Stack receipt");
  }
  if (
    !sortedUnique(receipt.worker.retainedVersionIds) ||
    !sortedUnique(receipt.worker.retainedDeploymentIds) ||
    receipt.worker.retainedVersionIds.includes(receipt.worker.versionId) ||
    receipt.worker.retainedDeploymentIds.includes(receipt.worker.deploymentId) ||
    !sortedUnique(receipt.workflow.retainedVersionIds) ||
    receipt.workflow.retainedVersionIds.includes(receipt.workflow.versionId) ||
    receipt.workflow.scriptName !== receipt.worker.name ||
    !Number.isSafeInteger(receipt.container.version) ||
    receipt.container.version < 1 ||
    !Number.isSafeInteger(receipt.container.maxInstances) ||
    receipt.container.maxInstances < 1 ||
    !Number.isSafeInteger(receipt.container.rolloutActiveGracePeriod) ||
    receipt.container.rolloutActiveGracePeriod < 0 ||
    !Number.isFinite(receipt.container.configuration.vcpu) ||
    receipt.container.configuration.vcpu < 0 ||
    Object.is(receipt.container.configuration.vcpu, -0) ||
    !Number.isSafeInteger(receipt.container.configuration.memoryMiB) ||
    receipt.container.configuration.memoryMiB < 0 ||
    !Number.isSafeInteger(receipt.container.configuration.diskSizeMb) ||
    receipt.container.configuration.diskSizeMb < 0 ||
    !Number.isSafeInteger(receipt.container.configuration.bandwidthLimitMbps) ||
    receipt.container.configuration.bandwidthLimitMbps < 0 ||
    !sortedUnique(receipt.container.tiers) ||
    !sortedUnique(receipt.container.rollouts.map(({ id }) => id)) ||
    !receipt.container.rollouts.some(
      ({ id, status, targetVersion }) =>
        id === receipt.container.rolloutId &&
        status === "completed" &&
        targetVersion === receipt.container.version,
    ) ||
    !receipt.namespaces.some(({ id }) => id === receipt.container.namespaceId) ||
    receipt.container.rollouts.some(
      ({ currentVersion, targetVersion }) =>
        !Number.isSafeInteger(currentVersion) ||
        !Number.isSafeInteger(targetVersion) ||
        currentVersion < 1 ||
        targetVersion < 1,
    ) ||
    !sortedUnique(receipt.namespaces.map(({ binding }) => binding)) ||
    !sortedUnique(receipt.bindings.map(({ name }) => name)) ||
    !sortedUnique(receipt.secretNames) ||
    !sortedUnique(receipt.schedules) ||
    !sortedUnique(receipt.routes.map(({ pattern }) => pattern)) ||
    !sortedUnique(receipt.secretSnapshot.ownedKeyBindings) ||
    !sortedUnique(receipt.buckets.map(({ name }) => name)) ||
    receipt.secretSnapshot.ownedKeyBindings.some(
      (name) =>
        !name.startsWith(`${SECRET_SNAPSHOT_KEY_BINDING}_`) || !receipt.secretNames.includes(name),
    ) ||
    receipt.namespaces.some(({ scriptName }) => scriptName !== receipt.worker.name) ||
    receipt.buckets.some(
      (bucket) =>
        (bucket.authority === "preserve-only" &&
          (!Number.isSafeInteger(bucket.objectCount) || bucket.objectCount < 0)) ||
        (bucket.authority === "delete-after-replacement" &&
          !sortedUnique(bucket.objects.map(({ key }) => key))),
    )
  ) {
    throw new Error("invalid legacy Stack receipt");
  }
};

const parse = (value: string): LegacyStackReceipt => {
  try {
    const receipt = JSON.parse(value) as LegacyStackReceipt;
    assertReceipt(receipt);
    if (canonical(receipt) !== value) throw new Error();
    return receipt;
  } catch {
    throw new Error("invalid persisted legacy Stack receipt");
  }
};

export class LegacyStack {
  readonly #expected: LegacyStackReceipt;
  readonly #control: LegacyStackControl;

  constructor(expected: LegacyStackReceipt, control: LegacyStackControl) {
    assertReceipt(expected);
    this.#expected = structuredClone(expected);
    this.#control = control;
  }

  async read(): Promise<LegacyStackReceipt | undefined> {
    const value = await this.#control.read();
    if (value === undefined) return undefined;
    const receipt = parse(value);
    if (canonical(receipt) !== canonical(this.#expected)) {
      throw new Error("legacy Stack receipt does not match allowlist");
    }
    return receipt;
  }

  async capture(): Promise<LegacyStackReceipt> {
    const inventory = await this.check();
    await this.#control.writeOnce(canonical(inventory));
    const reread = await this.read();
    if (!reread || canonical(reread) !== canonical(inventory)) {
      throw new Error("legacy Stack receipt persistence failed");
    }
    return reread;
  }

  async check(): Promise<LegacyStackReceipt> {
    const inventory = await this.#control.inventory();
    assertReceipt(inventory);
    if (canonical(inventory) !== canonical(this.#expected)) {
      throw new Error("legacy Stack inventory does not match allowlist");
    }
    const digest = await this.#control.resolveImageDigest(
      inventory.container.imageTag,
      inventory.container.platform,
    );
    if (digest !== inventory.container.resolvedImageDigest) {
      throw new Error("legacy Stack image digest does not match independent resolution");
    }
    return inventory;
  }
}
