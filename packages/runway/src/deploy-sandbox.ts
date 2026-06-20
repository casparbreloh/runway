import { firstResultItem, resultOf } from "./cloudflare-api.ts";
import type { CloudflareApi } from "./cloudflare-api.ts";
import { SANDBOX_BINDING, SANDBOX_CLASS, SANDBOX_IMAGE } from "./codegen.ts";

const sandboxNamespaceIdOf = (version: unknown): string | undefined => {
  const bindings =
    version && typeof version === "object"
      ? (version as { resources?: { bindings?: ReadonlyArray<unknown> } }).resources?.bindings
      : undefined;
  const binding = bindings?.find(
    (b) =>
      b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "durable_object_namespace" &&
      (b as { name?: unknown }).name === SANDBOX_BINDING &&
      (b as { class_name?: unknown }).class_name === SANDBOX_CLASS,
  );
  return binding && typeof (binding as { namespace_id?: unknown }).namespace_id === "string"
    ? (binding as { namespace_id: string }).namespace_id
    : undefined;
};

export const deploySandboxContainer = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
): Promise<void> => {
  const versionId = await firstResultItem(
    await cf.workers.scripts.versions.list(scriptName, { account_id: accountId, per_page: 1 }),
    (item) =>
      item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
        ? (item as { id: string }).id
        : undefined,
  );
  if (!versionId) throw new Error(`missing Worker version after deploy: ${scriptName}`);
  const namespaceId = sandboxNamespaceIdOf(
    resultOf(
      await cf.workers.scripts.versions.get(scriptName, versionId, { account_id: accountId }),
    ),
  );
  if (!namespaceId) throw new Error(`missing sandbox durable object namespace: ${SANDBOX_BINDING}`);

  const appName = `${scriptName}-${SANDBOX_CLASS}`;
  const apps = resultOf(await cf.containers.applications.list({ account_id: accountId }));
  const existing = Array.isArray(apps)
    ? apps.find(
        (app) => app && typeof app === "object" && (app as { name?: unknown }).name === appName,
      )
    : undefined;
  if (existing) {
    const existingNamespace = (existing as { durable_objects?: { namespace_id?: unknown } })
      .durable_objects?.namespace_id;
    if (existingNamespace !== namespaceId) {
      throw new Error(
        `container application ${appName} is attached to a different durable object namespace`,
      );
    }
    return;
  }

  await cf.containers.applications.create({
    account_id: accountId,
    body: {
      name: appName,
      scheduling_policy: "default",
      configuration: {
        image: SANDBOX_IMAGE,
        instance_type: "lite",
      },
      instances: 0,
      max_instances: 20,
      constraints: { tiers: [1, 2] },
      durable_objects: { namespace_id: namespaceId },
      rollout_active_grace_period: 0,
    },
  });
};
