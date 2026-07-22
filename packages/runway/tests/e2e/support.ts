import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import process from "node:process";
import { promisify } from "node:util";

import Cloudflare from "cloudflare";

const execFileAsync = promisify(execFile);

const GITHUB_DEPLOY_BINDINGS = [
  "RUNWAY_GITHUB_APP_ID",
  "RUNWAY_GITHUB_PRIVATE_KEY",
  "RUNWAY_GITHUB_WEBHOOK_SECRET",
] as const;

export const nonGitHubDeployEnv = (
  env: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const result = { ...env, ...overrides };
  for (const name of GITHUB_DEPLOY_BINDINGS) delete result[name];
  if (GITHUB_DEPLOY_BINDINGS.some((name) => result[name] !== undefined)) {
    throw new Error("non-GitHub live smoke inherited GitHub App publication config");
  }
  return result;
};

export const fetchWorkersDev = async (
  input: string,
  init: RequestInit,
): Promise<{ readonly status: number; readonly text: string }> => {
  const deadline = Date.now() + 60_000;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const response = await fetch(input, init);
    const text = await response.text();
    const startupMiss =
      (response.status === 404 && text.includes("There is nothing here yet")) ||
      (response.status === 500 &&
        (text.includes("Script not found") || text.includes("internal error; reference =")));
    if (!startupMiss) return { status: response.status, text };
    if (attempt === 60 || Date.now() >= deadline) {
      throw new Error(`workers.dev did not become reachable: ${text.slice(0, 1024)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("workers.dev did not become reachable within 60 attempts");
};

export const cloudflareToken = async (allowEnvironment = false): Promise<string> => {
  if (allowEnvironment && process.env.CLOUDFLARE_API_TOKEN) {
    return process.env.CLOUDFLARE_API_TOKEN;
  }
  const { stdout } = await execFileAsync("wrangler", ["auth", "token", "--json"], {
    timeout: 10_000,
  });
  const auth = JSON.parse(stdout) as { token?: unknown };
  if (typeof auth.token !== "string") throw new Error("Wrangler did not return an auth token");
  return auth.token;
};

export const cloudflareAccountId = async (
  cf: Cloudflare,
  listBeforeEnvironment = false,
): Promise<string> => {
  if (!listBeforeEnvironment && process.env.CLOUDFLARE_ACCOUNT_ID) {
    return process.env.CLOUDFLARE_ACCOUNT_ID;
  }
  const ids: string[] = [];
  for await (const account of cf.accounts.list()) ids.push(account.id);
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  if (ids.length !== 1)
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID when auth has multiple accounts");
  return ids[0]!;
};

export const cloudflareStatusIs = (error: unknown, status: number): boolean =>
  !!error && typeof error === "object" && "status" in error && error.status === status;

export const r2BucketExists = async (
  cf: Cloudflare,
  accountId: string,
  bucketName: string,
): Promise<boolean> => {
  try {
    await cf.r2.buckets.get(bucketName, { account_id: accountId });
    return true;
  } catch (error) {
    if (cloudflareStatusIs(error, 404)) return false;
    throw error;
  }
};

export const r2ObjectKeys = async (
  cf: Cloudflare,
  accountId: string,
  bucketName: string,
  prefix?: string,
): Promise<ReadonlySet<string>> => {
  if (!(await r2BucketExists(cf, accountId, bucketName))) return new Set();
  const keys = new Set<string>();
  for await (const object of cf.r2.buckets.objects.list(bucketName, {
    account_id: accountId,
    ...(prefix ? { prefix } : {}),
  })) {
    if (object.key) keys.add(object.key);
  }
  return keys;
};

export const r2ObjectExists = async (
  cf: Cloudflare,
  accountId: string,
  bucketName: string,
  objectKey: string,
): Promise<boolean> => {
  if (!(await r2BucketExists(cf, accountId, bucketName))) return false;
  try {
    await cf.r2.buckets.objects.get(objectKey, { account_id: accountId, bucket_name: bucketName });
    return true;
  } catch (error) {
    if (cloudflareStatusIs(error, 404)) return false;
    throw error;
  }
};

export interface ContainerApplication {
  readonly id: string;
  readonly name: string;
}

export const containerApplications = async (
  token: string,
  accountId: string,
): Promise<ReadonlyArray<ContainerApplication>> => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/applications`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Container list returned ${response.status}`);
  const body = (await response.json()) as {
    result?: ReadonlyArray<{ id?: unknown; name?: unknown }>;
  };
  return (body.result ?? []).flatMap((application) =>
    typeof application.id === "string" && typeof application.name === "string"
      ? [{ id: application.id, name: application.name }]
      : [],
  );
};

export const deleteContainer = async (
  token: string,
  accountId: string,
  applicationId: string,
): Promise<void> => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/applications/${applicationId}`,
    { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Container delete returned ${response.status}`);
  }
};

export const matchingScripts = async (
  cf: Cloudflare,
  accountId: string,
  names: ReadonlySet<string>,
): Promise<ReadonlyArray<string>> => {
  const matches: string[] = [];
  for await (const script of cf.workers.scripts.list({ account_id: accountId })) {
    if (typeof script.id === "string" && names.has(script.id)) matches.push(script.id);
  }
  return matches;
};

export interface WorkflowIdentity {
  readonly name: string;
  readonly scriptName?: string;
}

export const relatedWorkflows = async (
  cf: Cloudflare,
  accountId: string,
  scriptName: string,
): Promise<ReadonlyArray<WorkflowIdentity>> => {
  const matches: WorkflowIdentity[] = [];
  for await (const candidate of cf.workflows.list({ account_id: accountId })) {
    if (candidate.name === scriptName || candidate.script_name === scriptName) {
      matches.push({
        name: candidate.name ?? "<unnamed>",
        ...(candidate.script_name ? { scriptName: candidate.script_name } : {}),
      });
    }
  }
  return matches;
};

export const triggerSignedWebhook = async <Event>(
  url: string,
  event: Event,
  secret: string,
  signatureHeader: string,
): Promise<string> => {
  const body = JSON.stringify(event);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const response = await fetchWorkersDev(url, {
    method: "POST",
    headers: { "content-type": "application/json", [signatureHeader]: signature },
    body,
  });
  if (response.status !== 202) {
    throw new Error(`Webhook returned ${response.status}: ${response.text.slice(0, 1024)}`);
  }
  const result = JSON.parse(response.text) as { runs?: ReadonlyArray<{ id?: unknown }> };
  const id = result.runs?.[0]?.id;
  if (typeof id !== "string") throw new Error("Webhook response omitted run id");
  return id;
};

export interface LiveWorkflowDetails {
  readonly status: string;
  readonly steps: ReadonlyArray<{
    readonly type: string;
    readonly name?: string;
    readonly output?: string | null;
  }>;
}

export const waitForWorkflow = async <Details extends LiveWorkflowDetails>(
  cf: Cloudflare,
  accountId: string,
  workflowName: string,
  instanceId: string,
  accepts: (details: Details) => boolean,
  timeoutMs: number,
  redact: (diagnostic: string) => string = (diagnostic) => diagnostic,
): Promise<Details> => {
  const deadline = Date.now() + timeoutMs;
  let last: Details | undefined;
  while (Date.now() < deadline) {
    last = (await cf.workflows.instances.get(instanceId, {
      account_id: accountId,
      workflow_name: workflowName,
    })) as unknown as Details;
    if (accepts(last)) return last;
    if (["errored", "terminated"].includes(last.status)) {
      throw new Error(`Workflow ${instanceId} ${last.status}: ${redact(JSON.stringify(last))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for Workflow ${instanceId}: ${redact(JSON.stringify(last))}`);
};

export const workflowStepOutput = (details: LiveWorkflowDetails, name: string): string => {
  const output = details.steps.find(
    (step) => step.type === "step" && (step.name === name || step.name?.startsWith(`${name}-`)),
  )?.output;
  if (typeof output !== "string") throw new Error(`Missing output for step ${name}`);
  return output;
};
