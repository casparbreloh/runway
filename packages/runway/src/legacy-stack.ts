import { stackIdOf } from "./stack.ts";
import { SECRET_SNAPSHOT_KEY_BINDING } from "./worker-contract.ts";

interface LegacyObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
}

interface LegacyBucketState {
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
  readonly workflow: { readonly name: string; readonly id: string };
  readonly container: {
    readonly name: string;
    readonly id: string;
    readonly rolloutId: string;
    readonly imageTag: string;
    readonly resolvedImageDigest: string;
    readonly platform: { readonly os: "linux"; readonly architecture: "amd64" };
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
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
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
    receipt.container.name,
    receipt.container.id,
    receipt.container.rolloutId,
    receipt.container.imageTag,
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
    await this.#control.writeOnce(canonical(inventory));
    const reread = await this.read();
    if (!reread || canonical(reread) !== canonical(inventory)) {
      throw new Error("legacy Stack receipt persistence failed");
    }
    return reread;
  }
}
