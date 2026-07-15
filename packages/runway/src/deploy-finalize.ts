import { collectResultItems, resultOf } from "./cloudflare-api.ts";
import type { CloudflareApi } from "./cloudflare-api.ts";
import { cronsOf } from "./registry.ts";
import type { Registry } from "./types.ts";
import { DYNAMIC_WORKFLOW_CLASS } from "./worker-contract.ts";

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

interface DynamicWorkflowResource {
  readonly name: string;
  readonly scriptName?: string;
}

const dynamicWorkflows = async (
  cf: CloudflareApi,
  accountId: string,
): Promise<ReadonlyArray<DynamicWorkflowResource>> =>
  await collectResultItems(
    await cf.workflows.list({ account_id: accountId }),
    (workflow): DynamicWorkflowResource | undefined => {
      if (!workflow || typeof workflow !== "object") return undefined;
      const { name, script_name: scriptName } = workflow as Record<string, unknown>;
      if (typeof name !== "string") return undefined;
      return {
        name,
        ...(typeof scriptName === "string" ? { scriptName } : {}),
      };
    },
  );

export const assertDynamicWorkflowOwnership = async (
  cf: CloudflareApi,
  accountId: string,
  workflowName: string,
  scriptName: string,
): Promise<void> => {
  const collision = (await dynamicWorkflows(cf, accountId)).find(
    (workflow) => workflow.name === workflowName && workflow.scriptName !== scriptName,
  );
  if (collision) {
    throw new Error(
      `Dynamic Workflow ${workflowName} already belongs to Worker ${collision.scriptName ?? "<unknown>"}`,
    );
  }
};

export const deleteStaleDynamicWorkflows = async (
  cf: CloudflareApi,
  accountId: string,
  workflowName: string,
  scriptName: string,
): Promise<void> => {
  for (const wf of await dynamicWorkflows(cf, accountId)) {
    if (wf.scriptName === scriptName && wf.name !== workflowName) {
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

export const enableWorkersDev = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
  registry: Registry,
): Promise<{
  readonly host: string;
  readonly urls: ReadonlyArray<{ readonly id: string; readonly url: string }>;
}> => {
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
  return {
    host,
    urls: registry.flatMap((w) =>
      w.def.trigger.type === "webhook"
        ? [{ id: w.def.id, url: `https://${host}${w.def.trigger.path}` }]
        : [],
    ),
  };
};

const READINESS_CONSECUTIVE_MATCHES = 31;
const READINESS_MAX_ATTEMPTS = 120;
const READINESS_INTERVAL_MS = 1000;
const READINESS_OBSERVATION_TIMEOUT_MS = 10_000;

export const waitForDeploymentReadiness = async (opts: {
  readonly fetch: typeof globalThis.fetch;
  readonly wait: (durationMs: number) => Promise<void>;
  readonly host: string;
  readonly scriptName: string;
  readonly deploymentId: string;
  readonly observationTimeoutMs?: number;
}): Promise<void> => {
  let matches = 0;
  for (let attempt = 0; attempt < READINESS_MAX_ATTEMPTS; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        opts.observationTimeoutMs ?? READINESS_OBSERVATION_TIMEOUT_MS,
      );
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("readiness observation timed out")),
          { once: true },
        );
      });
      try {
        const response = await Promise.race([
          opts.fetch(`https://${opts.host}/.runway/version?attempt=${attempt}`, {
            headers: { "Cache-Control": "no-cache", Connection: "close" },
            signal: controller.signal,
          }),
          aborted,
        ]);
        const body = response.ok
          ? ((await Promise.race([response.json(), aborted])) as { deploymentId?: unknown })
          : undefined;
        matches = body?.deploymentId === opts.deploymentId ? matches + 1 : 0;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      matches = 0;
    }
    if (matches === READINESS_CONSECUTIVE_MATCHES) return;
    if (attempt < READINESS_MAX_ATTEMPTS - 1) await opts.wait(READINESS_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for Worker ${opts.scriptName} deployment ${opts.deploymentId} to become ready`,
  );
};
