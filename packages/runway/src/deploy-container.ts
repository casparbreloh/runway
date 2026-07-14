import { collectResultItems, resultOf } from "./cloudflare-api.ts";
import type { CloudflareApi } from "./cloudflare-api.ts";
import { SANDBOX_BINDING, SANDBOX_CLASS, SANDBOX_IMAGE, SANDBOX_MIGRATION_TAG } from "./codegen.ts";

const desiredApplication = {
  scheduling_policy: "default",
  configuration: { image: SANDBOX_IMAGE, instance_type: "lite" },
  instances: 0,
  max_instances: 20,
  constraints: { tiers: [1, 2] },
  rollout_active_grace_period: 0,
} as const;

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
      configuration?: { image?: unknown; instance_type?: unknown };
      durable_objects?: { namespace_id?: unknown };
      rollout_active_grace_period?: unknown;
    };
    const attached = application.durable_objects?.namespace_id;
    if (attached !== namespaceId) {
      throw new Error(`container application ${name} is attached to a different namespace`);
    }
    const matches =
      application.scheduling_policy === desiredApplication.scheduling_policy &&
      application.instances === desiredApplication.instances &&
      application.max_instances === desiredApplication.max_instances &&
      application.configuration?.image === desiredApplication.configuration.image &&
      application.configuration.instance_type === desiredApplication.configuration.instance_type &&
      JSON.stringify(application.constraints?.tiers) ===
        JSON.stringify(desiredApplication.constraints.tiers) &&
      application.rollout_active_grace_period === desiredApplication.rollout_active_grace_period;
    if (matches) return;
    if (typeof application.id !== "string") {
      throw new Error(`container application ${name} has no id`);
    }
    await cf.containers.applications.modify(application.id, {
      account_id: accountId,
      body: desiredApplication,
    });
    return;
  }

  await cf.containers.applications.create({
    account_id: accountId,
    body: {
      name,
      ...desiredApplication,
      durable_objects: { namespace_id: namespaceId },
    },
  });
};

export const needsSandboxMigration = (tag: string | undefined): boolean =>
  tag !== SANDBOX_MIGRATION_TAG;
