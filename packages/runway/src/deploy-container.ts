import { collectResultItems, resultOf } from "./cloudflare-api.ts";
import type { CloudflareApi } from "./cloudflare-api.ts";
import {
  GITHUB_COORDINATOR_CLASS,
  GITHUB_COORDINATOR_MIGRATION_TAG,
  SANDBOX_APPLICATION,
  SANDBOX_BINDING,
  SANDBOX_CLASS,
  SANDBOX_MIGRATION_TAG,
} from "./sandbox-config.ts";

const INSTANCE_TYPES = {
  lite: { vcpu: 0.0625, memoryMib: 256, diskMb: 2_000 },
  basic: { vcpu: 0.25, memoryMib: 1_024, diskMb: 4_000 },
  "standard-1": { vcpu: 0.5, memoryMib: 4_096, diskMb: 8_000 },
  "standard-2": { vcpu: 1, memoryMib: 6_144, diskMb: 12_000 },
  "standard-3": { vcpu: 2, memoryMib: 8_192, diskMb: 16_000 },
  "standard-4": { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 },
} as const;

const matchesInstanceType = (configuration: {
  instance_type?: unknown;
  vcpu?: unknown;
  memory_mib?: unknown;
  disk?: { size_mb?: unknown };
}): boolean => {
  const instanceType = SANDBOX_APPLICATION.configuration.instance_type;
  if (configuration.instance_type === instanceType) return true;
  const expected = INSTANCE_TYPES[instanceType];
  return (
    configuration.vcpu === expected.vcpu &&
    configuration.memory_mib === expected.memoryMib &&
    configuration.disk?.size_mb === expected.diskMb
  );
};

const waitForRollout = async (
  cf: CloudflareApi,
  accountId: string,
  applicationId: string,
  rolloutId: string,
): Promise<void> => {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const rollout = resultOf(
      await cf.containers.rollouts.get(applicationId, rolloutId, { account_id: accountId }),
    );
    const status =
      rollout && typeof rollout === "object" ? (rollout as { status?: unknown }).status : undefined;
    if (status === "completed") return;
    if (status === "reverted" || status === "replaced") {
      throw new Error(`container rollout ${status}`);
    }
    if (status !== "pending" && status !== "progressing") {
      throw new Error("invalid container rollout status");
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("container rollout timed out");
};

export const currentSandboxMigrationTag = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
): Promise<string | undefined> => {
  const scripts = await collectResultItems(
    await cf.workers.scripts.list({ account_id: accountId }),
    (item): { id: string; migrationTag?: string } | undefined => {
      if (!item || typeof item !== "object") return undefined;
      const script = item as { id?: unknown; migration_tag?: unknown };
      if (typeof script.id !== "string") return undefined;
      return {
        id: script.id,
        ...(typeof script.migration_tag === "string" ? { migrationTag: script.migration_tag } : {}),
      };
    },
  );
  return scripts.find((script) => script.id === scriptName)?.migrationTag;
};

const firstVersionId = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
): Promise<string> => {
  const versions = await collectResultItems(
    await cf.workers.scripts.versions.list(scriptName, { account_id: accountId, per_page: 1 }),
    (item) =>
      item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
        ? (item as { id: string }).id
        : undefined,
  );
  const versionId = versions[0];
  if (!versionId) throw new Error(`missing Worker version after deploy: ${scriptName}`);
  return versionId;
};

const sandboxNamespaceId = (version: unknown): string | undefined => {
  const bindings =
    version && typeof version === "object"
      ? (version as { resources?: { bindings?: ReadonlyArray<unknown> } }).resources?.bindings
      : undefined;
  const binding = bindings?.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      (candidate as { type?: unknown }).type === "durable_object_namespace" &&
      (candidate as { name?: unknown }).name === SANDBOX_BINDING &&
      (candidate as { class_name?: unknown }).class_name === SANDBOX_CLASS,
  );
  return binding && typeof (binding as { namespace_id?: unknown }).namespace_id === "string"
    ? (binding as { namespace_id: string }).namespace_id
    : undefined;
};

export const reconcileSandboxContainer = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
): Promise<void> => {
  const versionId = await firstVersionId(cf, accountId, scriptName);
  const version = resultOf(
    await cf.workers.scripts.versions.get(scriptName, versionId, { account_id: accountId }),
  );
  const namespaceId = sandboxNamespaceId(version);
  if (!namespaceId) throw new Error(`missing sandbox durable object namespace: ${SANDBOX_BINDING}`);

  const name = `${scriptName}-${SANDBOX_CLASS}`;
  const applications = resultOf(await cf.containers.applications.list({ account_id: accountId }));
  const existing = Array.isArray(applications)
    ? applications.find(
        (application) =>
          application &&
          typeof application === "object" &&
          (application as { name?: unknown }).name === name,
      )
    : undefined;
  if (existing) {
    const application = existing as {
      id?: unknown;
      scheduling_policy?: unknown;
      instances?: unknown;
      max_instances?: unknown;
      constraints?: { tiers?: unknown };
      configuration?: {
        image?: unknown;
        instance_type?: unknown;
        vcpu?: unknown;
        memory_mib?: unknown;
        disk?: { size_mb?: unknown };
      };
      durable_objects?: { namespace_id?: unknown };
      rollout_active_grace_period?: unknown;
    };
    const attached = application.durable_objects?.namespace_id;
    if (attached !== namespaceId) {
      throw new Error(`container application ${name} is attached to a different namespace`);
    }
    const matches =
      application.scheduling_policy === SANDBOX_APPLICATION.scheduling_policy &&
      application.max_instances === SANDBOX_APPLICATION.max_instances &&
      application.configuration?.image === SANDBOX_APPLICATION.configuration.image &&
      matchesInstanceType(application.configuration ?? {}) &&
      JSON.stringify(application.constraints?.tiers) ===
        JSON.stringify(SANDBOX_APPLICATION.constraints.tiers) &&
      application.rollout_active_grace_period === SANDBOX_APPLICATION.rollout_active_grace_period;
    if (matches) return;
    if (typeof application.id !== "string") {
      throw new Error(`container application ${name} has no id`);
    }
    await cf.containers.applications.modify(application.id, {
      account_id: accountId,
      body: SANDBOX_APPLICATION,
    });
    const rollout = resultOf(
      await cf.containers.rollouts.create(application.id, {
        account_id: accountId,
        body: {
          description: "Runway deployment",
          strategy: "rolling",
          target_configuration: SANDBOX_APPLICATION.configuration,
          step_percentage: 25,
          kind: "full_auto",
        },
      }),
    );
    const rolloutId =
      rollout && typeof rollout === "object" ? (rollout as { id?: unknown }).id : undefined;
    if (typeof rolloutId !== "string") throw new Error("invalid container rollout");
    await waitForRollout(cf, accountId, application.id, rolloutId);
    return;
  }

  await cf.containers.applications.create({
    account_id: accountId,
    body: {
      name,
      ...SANDBOX_APPLICATION,
      durable_objects: { namespace_id: namespaceId },
    },
  });
};

export interface RunwayMigration {
  readonly old_tag?: string;
  readonly new_tag: string;
  readonly new_sqlite_classes: ReadonlyArray<string>;
}

export const runwayMigration = (tag: string | undefined): RunwayMigration | undefined => {
  if (tag === undefined) {
    return {
      new_tag: GITHUB_COORDINATOR_MIGRATION_TAG,
      new_sqlite_classes: [SANDBOX_CLASS, GITHUB_COORDINATOR_CLASS],
    };
  }
  if (tag === SANDBOX_MIGRATION_TAG) {
    return {
      old_tag: SANDBOX_MIGRATION_TAG,
      new_tag: GITHUB_COORDINATOR_MIGRATION_TAG,
      new_sqlite_classes: [GITHUB_COORDINATOR_CLASS],
    };
  }
  if (tag === GITHUB_COORDINATOR_MIGRATION_TAG) return undefined;
  throw new Error(`unsupported Runway Worker migration tag: ${tag}`);
};
