import { resultOf } from "./cloudflare-api.ts";
import type { CloudflareApi } from "./cloudflare-api.ts";
import { DYNAMIC_WORKFLOW_CLASS, cronsOf } from "./codegen.ts";
import type { Registry } from "./types.ts";

export const updateDynamicWorkflow = async (
  cf: CloudflareApi,
  accountId: string,
  workflowName: string,
  scriptName: string,
): Promise<void> => {
  await cf.workflows.update(workflowName, {
    account_id: accountId,
    class_name: DYNAMIC_WORKFLOW_CLASS,
    script_name: scriptName,
  });
};

export const deleteStaleDynamicWorkflows = async (
  cf: CloudflareApi,
  accountId: string,
  workflowName: string,
  scriptName: string,
): Promise<void> => {
  const deployed = resultOf(await cf.workflows.list({ account_id: accountId }));
  for (const wf of Array.isArray(deployed)
    ? (deployed as ReadonlyArray<{ name?: string; script_name?: string }>)
    : []) {
    if (wf.script_name === scriptName && typeof wf.name === "string" && wf.name !== workflowName) {
      await cf.workflows.delete(wf.name, { account_id: accountId });
    }
  }
};

export const updateCronSchedules = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
  registry: Registry,
): Promise<void> => {
  await cf.workers.scripts.schedules.update(scriptName, {
    account_id: accountId,
    body: cronsOf(registry).map((cron) => ({ cron })),
  });
};

export const workersDevWebhookUrls = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
  registry: Registry,
): Promise<ReadonlyArray<{ readonly id: string; readonly url: string }>> => {
  await cf.workers.scripts.subdomain.create(scriptName, { account_id: accountId, enabled: true });
  const account = resultOf(await cf.workers.subdomains.get({ account_id: accountId })) as {
    subdomain?: string;
  } | null;
  if (typeof account?.subdomain !== "string" || account.subdomain.length === 0) {
    throw new Error(
      "no workers.dev subdomain on this account: register one in the Cloudflare dashboard",
    );
  }
  const host = `${scriptName}.${account.subdomain}.workers.dev`;
  return registry.flatMap((w) =>
    w.def.trigger.type === "webhook"
      ? [{ id: w.def.id, url: `https://${host}${w.def.trigger.path}` }]
      : [],
  );
};
