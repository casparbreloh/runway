import process from "node:process";

import type { CloudflareApi } from "./cloudflare-api.ts";
import { resolveAuth } from "./deploy-auth.ts";
import { buildWorkerBundle } from "./deploy-bundle.ts";
import {
  deleteStaleDynamicWorkflows,
  updateCronSchedules,
  updateDynamicWorkflow,
  workersDevWebhookUrls,
} from "./deploy-finalize.ts";
import { deploySandboxContainer } from "./deploy-sandbox.ts";
import { currentWorkerMigrationTag, uploadWorker, validateBindings } from "./deploy-upload.ts";
import { resolveScriptName } from "./naming.ts";
import { secretNamesOf } from "./registry.ts";
import { listScriptSecrets } from "./secret-store.ts";
import type { ProgressEvent, Registry } from "./types.ts";

export type { CloudflareApi } from "./cloudflare-api.ts";
export { resolveAuth } from "./deploy-auth.ts";

interface DeployContext {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly client?: (opts: { apiToken: string }) => CloudflareApi;
  readonly wranglerAuth?: boolean;
}

interface DeployOutput {
  readonly script: string;
  readonly urls: ReadonlyArray<{ readonly id: string; readonly url: string }>;
}

export const deploy = async (registry: Registry, opts: DeployContext): Promise<DeployOutput> => {
  const env = opts.env ?? process.env;
  const secrets = secretNamesOf(registry);
  const scriptName = await resolveScriptName({ cwd: opts.cwd, env });
  const workflowName = scriptName;
  const { accountId, cf } = await resolveAuth(opts, env);
  const remoteSecrets = await listScriptSecrets(cf, accountId, scriptName);
  const missingSecrets = registry.flatMap((w) =>
    w.def.secrets
      .filter((name) => !env[name] && !remoteSecrets.has(name))
      .map((name) => `${w.def.id}.${name}`),
  );
  if (missingSecrets.length > 0) {
    throw new Error(`missing secret(s): ${missingSecrets.join(", ")}`);
  }

  validateBindings(secrets);
  const localSecretBindings = secrets.filter((name) => env[name]);
  const contents = await buildWorkerBundle(registry, opts);
  const migrationTag = await currentWorkerMigrationTag(cf, accountId, scriptName);

  opts.onProgress?.({ step: "deploy", status: "start" });
  await uploadWorker(cf, {
    accountId,
    scriptName,
    workflowName,
    contents,
    env,
    localSecretBindings,
    migrationTag,
  });
  await deploySandboxContainer(cf, accountId, scriptName);
  await updateDynamicWorkflow(cf, accountId, workflowName, scriptName);
  await updateCronSchedules(cf, accountId, scriptName, registry);
  await deleteStaleDynamicWorkflows(cf, accountId, workflowName, scriptName);
  const urls = await workersDevWebhookUrls(cf, accountId, scriptName, registry);

  opts.onProgress?.({ step: "deploy", status: "done" });
  return { script: scriptName, urls };
};
