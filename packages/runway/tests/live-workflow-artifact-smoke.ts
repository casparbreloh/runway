import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import Cloudflare from "cloudflare";
import { webhook, workflow } from "runway";
import type { Registry } from "runway";

import { buildDeployment } from "../src/deploy-build.ts";
import { artifactBucketName, ensureArtifactBucket } from "../src/deploy-storage.ts";
import { deploy } from "../src/deploy.ts";
import { resolveRepositorySource } from "../src/repository-source.ts";
import { setScriptSecret } from "../src/secret-store.ts";
import { workflowArtifactKey } from "../src/workflow-artifact.ts";
import { fetchWorkersDev, nonGitHubDeployEnv } from "./live-smoke-helpers.ts";

const execFileAsync = promisify(execFile);

const hookSecret = `hook-${randomUUID()}`;
const oldSecret = `old-${randomUUID()}`;
const newSecret = `new-${randomUUID()}`;
const secretValues = [hookSecret, oldSecret, newSecret];

interface SmokeEvent {
  readonly sleepMs: number;
  readonly expectedSecretHash: string;
  readonly rejectedSecretHash: string;
  readonly printSecret: boolean;
}

interface InstanceDetails {
  readonly status: string;
  readonly success: boolean | null;
  readonly error: { readonly message: string; readonly name: string } | null;
  readonly steps: ReadonlyArray<{
    readonly type: string;
    readonly name?: string;
    readonly output?: string | null;
    readonly finished?: boolean;
  }>;
}

const smokeDefinition = workflow({
  id: "immutable-smoke",
  secrets: ["HOOK_SECRET", "SMOKE_SECRET"],
  trigger: (ctx) =>
    webhook<SmokeEvent>({
      path: "/smoke",
      secret: ctx.secrets.HOOK_SECRET,
      signatureHeader: "x-smoke-signature",
    }),
}).handler(async () => {});

const registry = (cwd: string): Registry => [
  {
    path: path.join(cwd, ".runway/workflows/smoke.ts"),
    exportName: "default",
    def: smokeDefinition,
  },
];

const workflowSource = (bodyVersion: "v1" | "v2", scriptName: string): string => `
import { webhook, workflow } from "runway";

interface SmokeEvent {
  readonly sleepMs: number;
  readonly expectedSecretHash: string;
  readonly rejectedSecretHash: string;
  readonly printSecret: boolean;
}

const hash = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export default workflow({
  id: "immutable-smoke",
  secrets: ["HOOK_SECRET", "SMOKE_SECRET"],
  trigger: (ctx) => webhook<SmokeEvent>({
    path: "/smoke",
    secret: ctx.secrets.HOOK_SECRET,
    signatureHeader: "x-smoke-signature",
  }),
}).handler(async (ctx, event) => {
  await ctx.step.do("version-before", () => ({ bodyVersion: ${JSON.stringify(bodyVersion)}, scriptName: ${JSON.stringify(scriptName)} }));
  if (event.sleepMs > 0) await ctx.step.sleep("hold-v1", event.sleepMs);
  await ctx.step.do("version-after", () => ({ bodyVersion: ${JSON.stringify(bodyVersion)} }));
  const actualSecretHash = await hash(ctx.secrets.SMOKE_SECRET);
  await ctx.step.do("secret-state", () => ({
    matchesExpected: actualSecretHash === event.expectedSecretHash,
    matchesRejected: actualSecretHash === event.rejectedSecretHash,
  }));
  if (event.printSecret) {
    await ctx.step.exec("secret-output", {
      command: ${JSON.stringify(`printf '%s\\n' "$RUNWAY_SMOKE_SECRET"`)},
      env: { RUNWAY_SMOKE_SECRET: ctx.secrets.SMOKE_SECRET },
    });
  }
});
`;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const tokenOf = async (): Promise<string> => {
  const { stdout } = await execFileAsync("wrangler", ["auth", "token", "--json"], {
    timeout: 10_000,
  });
  const auth = JSON.parse(stdout) as { token?: unknown };
  if (typeof auth.token !== "string") throw new Error("Wrangler did not return an auth token");
  return auth.token;
};

const oneAccountId = async (cf: Cloudflare): Promise<string> => {
  const ids: string[] = [];
  for await (const account of cf.accounts.list()) ids.push(account.id);
  const explicit = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (explicit) return explicit;
  if (ids.length !== 1)
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID when auth has multiple accounts");
  return ids[0]!;
};

const isStatus = (error: unknown, status: number): boolean =>
  !!error && typeof error === "object" && "status" in error && error.status === status;

const bucketExists = async (
  cf: Cloudflare,
  accountId: string,
  bucketName: string,
): Promise<boolean> => {
  try {
    await cf.r2.buckets.get(bucketName, { account_id: accountId });
    return true;
  } catch (error) {
    if (isStatus(error, 404)) return false;
    throw error;
  }
};

const objectKeys = async (
  cf: Cloudflare,
  accountId: string,
  bucketName: string,
  prefix?: string,
): Promise<ReadonlySet<string>> => {
  if (!(await bucketExists(cf, accountId, bucketName))) return new Set();
  const keys = new Set<string>();
  for await (const object of cf.r2.buckets.objects.list(bucketName, {
    account_id: accountId,
    ...(prefix ? { prefix } : {}),
  })) {
    if (object.key) keys.add(object.key);
  }
  return keys;
};

const objectExists = async (
  cf: Cloudflare,
  accountId: string,
  bucketName: string,
  objectKey: string,
): Promise<boolean> => {
  if (!(await bucketExists(cf, accountId, bucketName))) return false;
  try {
    await cf.r2.buckets.objects.get(bucketName, objectKey, { account_id: accountId });
    return true;
  } catch (error) {
    if (isStatus(error, 404)) return false;
    throw error;
  }
};

const firstVersionId = async (
  cf: Cloudflare,
  accountId: string,
  scriptName: string,
): Promise<string> => {
  for await (const version of cf.workers.scripts.versions.list(scriptName, {
    account_id: accountId,
    per_page: 1,
  })) {
    if (typeof version.id === "string") return version.id;
  }
  throw new Error(`No Worker version found for ${scriptName}`);
};

const deploymentIdAt = async (host: string): Promise<string> => {
  const response = await fetch(`https://${host}/.runway/version`);
  if (!response.ok) throw new Error(`Version endpoint returned ${response.status}`);
  const body = (await response.json()) as { deploymentId?: unknown };
  if (typeof body.deploymentId !== "string")
    throw new Error("Version endpoint omitted deploymentId");
  if (response.headers.get("cache-control") !== "no-store") {
    throw new Error("Version endpoint did not return Cache-Control: no-store");
  }
  return body.deploymentId;
};

const trigger = async (url: string, event: SmokeEvent): Promise<string> => {
  const body = JSON.stringify(event);
  const signature = createHmac("sha256", hookSecret).update(body).digest("hex");
  const response = await fetchWorkersDev(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-smoke-signature": signature },
    body,
  });
  if (response.status !== 202)
    throw new Error(`Webhook returned ${response.status}: ${response.text.slice(0, 1024)}`);
  const result = JSON.parse(response.text) as { runs?: ReadonlyArray<{ id?: unknown }> };
  const id = result.runs?.[0]?.id;
  if (typeof id !== "string") throw new Error("Webhook response omitted run id");
  return id;
};

const instance = async (
  cf: Cloudflare,
  accountId: string,
  workflowName: string,
  instanceId: string,
): Promise<InstanceDetails> =>
  (await cf.workflows.instances.get(workflowName, instanceId, {
    account_id: accountId,
  })) as InstanceDetails;

const waitFor = async (
  cf: Cloudflare,
  accountId: string,
  workflowName: string,
  instanceId: string,
  accepts: (details: InstanceDetails) => boolean,
  timeoutMs: number,
): Promise<InstanceDetails> => {
  const deadline = Date.now() + timeoutMs;
  let last: InstanceDetails | undefined;
  while (Date.now() < deadline) {
    const details = await instance(cf, accountId, workflowName, instanceId);
    last = details;
    if (accepts(details)) return details;
    if (["errored", "terminated"].includes(details.status)) {
      const diagnostic = JSON.stringify(details)
        .replaceAll(hookSecret, "***")
        .replaceAll(oldSecret, "***")
        .replaceAll(newSecret, "***");
      throw new Error(`Workflow ${instanceId} ${details.status}: ${diagnostic}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for Workflow ${instanceId}: ${JSON.stringify(last)}`);
};

const stepNameMatches = (actual: string | undefined, expected: string): boolean =>
  actual === expected || actual?.startsWith(`${expected}-`) === true;

const stepOutput = (details: InstanceDetails, name: string): string => {
  const output = details.steps.find(
    (step) => step.type === "step" && stepNameMatches(step.name, name),
  )?.output;
  if (typeof output !== "string") throw new Error(`Missing output for step ${name}`);
  return output;
};

const assertOutput = (
  details: InstanceDetails,
  bodyVersion: "v1" | "v2",
  matchesExpected: boolean,
  matchesRejected: boolean,
): void => {
  for (const name of ["version-before", "version-after"]) {
    const output = JSON.parse(stepOutput(details, name)) as { bodyVersion?: unknown };
    if (output.bodyVersion !== bodyVersion) {
      throw new Error(`${name} used ${String(output.bodyVersion)} instead of ${bodyVersion}`);
    }
  }
  const secret = JSON.parse(stepOutput(details, "secret-state")) as {
    matchesExpected?: unknown;
    matchesRejected?: unknown;
  };
  if (secret.matchesExpected !== matchesExpected || secret.matchesRejected !== matchesRejected) {
    throw new Error(`Unexpected secret-state output: ${JSON.stringify(secret)}`);
  }
};

const containerApplications = async (
  token: string,
  accountId: string,
): Promise<ReadonlyArray<{ readonly id: string; readonly name: string }>> => {
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

const deleteContainer = async (
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

const matchingScripts = async (
  cf: Cloudflare,
  accountId: string,
  scriptName: string,
): Promise<ReadonlyArray<string>> => {
  const scripts: string[] = [];
  for await (const script of cf.workers.scripts.list({ account_id: accountId })) {
    if (script.id === scriptName) scripts.push(script.id);
  }
  return scripts;
};

interface WorkflowIdentity {
  readonly name: string;
  readonly scriptName?: string;
}

const relatedWorkflows = async (
  cf: Cloudflare,
  accountId: string,
  scriptName: string,
): Promise<ReadonlyArray<WorkflowIdentity>> => {
  const workflows: WorkflowIdentity[] = [];
  for await (const candidate of cf.workflows.list({ account_id: accountId })) {
    if (candidate.name === scriptName || candidate.script_name === scriptName) {
      workflows.push({
        name: candidate.name ?? "<unnamed>",
        ...(candidate.script_name ? { scriptName: candidate.script_name } : {}),
      });
    }
  }
  return workflows;
};

const run = async (): Promise<void> => {
  const startedAt = Date.now();
  const suffix = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
  const scriptName = process.env.RUNWAY_SMOKE_SCRIPT ?? `runway-artifact-smoke-${suffix}`;
  const containerName = `${scriptName}-Sandbox`;
  const token = await tokenOf();
  const cf = new Cloudflare({ apiToken: token });
  const accountId = await oneAccountId(cf);
  const bucketName = artifactBucketName(accountId);
  const collisions = [
    ...(await matchingScripts(cf, accountId, scriptName)).map((name) => `Worker ${name}`),
    ...(await relatedWorkflows(cf, accountId, scriptName)).map(
      (workflow) => `Workflow ${workflow.name} (Worker ${workflow.scriptName ?? "<unknown>"})`,
    ),
    ...(await containerApplications(token, accountId))
      .filter((candidate) => candidate.name === containerName)
      .map((candidate) => `container ${candidate.name}`),
  ];
  if (collisions.length > 0) {
    throw new Error(`Refusing to overwrite pre-existing smoke resources: ${collisions.join(", ")}`);
  }
  const project = await mkdtemp(
    path.join(path.resolve(import.meta.dirname, ".."), ".tmp-immutable-smoke-"),
  );
  const workflowPath = path.join(project, ".runway/workflows/smoke.ts");
  const createdObjectKeys = new Set<string>();
  const ownPreparedArtifacts = async (artifactVersions: ReadonlyArray<string>): Promise<void> => {
    const keys = artifactVersions.map(workflowArtifactKey);
    const collisions: string[] = [];
    for (const key of keys) {
      if (await objectExists(cf, accountId, bucketName, key)) collisions.push(key);
    }
    if (collisions.length > 0) {
      throw new Error(`Refusing to overwrite pre-existing smoke objects: ${collisions.join(", ")}`);
    }
    for (const key of keys) createdObjectKeys.add(key);
  };
  const verifyOwnedArtifact = async (artifactVersion: string): Promise<void> => {
    const key = workflowArtifactKey(artifactVersion);
    if (!createdObjectKeys.has(key)) throw new Error(`Smoke did not preflight artifact ${key}`);
    if (!(await objectExists(cf, accountId, bucketName, key))) {
      throw new Error(`Deploy did not create artifact ${key}`);
    }
  };
  const timings: Record<string, number> = {};
  const identities: Record<string, unknown> = {
    scriptName,
    workflowName: scriptName,
    containerName,
  };
  let smokeError: unknown;
  let cleanupError: Error | undefined;
  let report: Record<string, unknown> | undefined;
  let bucketCreated = false;

  try {
    bucketCreated = await ensureArtifactBucket(cf, accountId, bucketName);
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(path.join(project, "package.json"), JSON.stringify({ name: scriptName }));
    const repository = await resolveRepositorySource(project);
    console.log(JSON.stringify({ phase: "start", accountId, scriptName, bucketName }));
    await writeFile(workflowPath, workflowSource("v1", scriptName));
    const preparedV1 = await buildDeployment(registry(project), {
      cwd: project,
      scriptName,
      repository,
      snapshotKeyAvailable: true,
    });
    const expectedV1Artifacts = preparedV1.artifacts.map(({ artifactVersion }) => artifactVersion);
    await ownPreparedArtifacts(expectedV1Artifacts);
    const v1Started = Date.now();
    const v1 = await deploy(registry(project), {
      cwd: project,
      env: nonGitHubDeployEnv(process.env, {
        RUNWAY_SCRIPT_NAME: scriptName,
        HOOK_SECRET: hookSecret,
        SMOKE_SECRET: oldSecret,
      }),
    });
    timings.v1DeployMs = Date.now() - v1Started;
    const webhookUrl = v1.urls[0]?.url;
    if (!webhookUrl) throw new Error("Deploy returned no webhook URL");
    const host = new URL(webhookUrl).host;
    const v1DeploymentId = await deploymentIdAt(host);
    identities.v1DeploymentId = v1DeploymentId;
    identities.v1WorkerVersionId = await firstVersionId(cf, accountId, scriptName);
    if (JSON.stringify(v1.artifactVersions) !== JSON.stringify(expectedV1Artifacts)) {
      throw new Error("First deploy returned unexpected workflow artifacts");
    }
    const v1ArtifactVersion = v1.artifactVersions[0]!;
    identities.v1ArtifactVersion = v1ArtifactVersion;
    await verifyOwnedArtifact(v1ArtifactVersion);
    console.log(
      JSON.stringify({
        phase: "v1-deployed",
        deploymentId: identities.v1DeploymentId,
        workerVersionId: identities.v1WorkerVersionId,
        artifactVersion: identities.v1ArtifactVersion,
        deployMs: timings.v1DeployMs,
      }),
    );

    const oldHash = sha256(oldSecret);
    const newHash = sha256(newSecret);
    const sleepingStarted = Date.now();
    const sleepingRunId = await trigger(webhookUrl, {
      sleepMs: 180_000,
      expectedSecretHash: oldHash,
      rejectedSecretHash: newHash,
      printSecret: false,
    });
    const sleeping = await waitFor(
      cf,
      accountId,
      scriptName,
      sleepingRunId,
      (details) =>
        ["running", "waiting"].includes(details.status) &&
        details.steps.some(
          (step) =>
            step.type === "sleep" && stepNameMatches(step.name, "hold-v1") && !step.finished,
        ),
      60_000,
    );
    timings.v1ReachedSleepMs = Date.now() - sleepingStarted;
    identities.v1SleepingRunId = sleepingRunId;
    identities.v1StatusBeforeRedeploy = sleeping.status;

    await writeFile(workflowPath, workflowSource("v2", scriptName));
    const preparedV2 = await buildDeployment(registry(project), {
      cwd: project,
      scriptName,
      repository,
      snapshotKeyAvailable: true,
    });
    const expectedV2Artifacts = preparedV2.artifacts.map(({ artifactVersion }) => artifactVersion);
    await ownPreparedArtifacts(expectedV2Artifacts);
    const v2Started = Date.now();
    const v2 = await deploy(registry(project), {
      cwd: project,
      env: nonGitHubDeployEnv(process.env, {
        RUNWAY_SCRIPT_NAME: scriptName,
        HOOK_SECRET: hookSecret,
        SMOKE_SECRET: oldSecret,
      }),
    });
    timings.v2DeployMs = Date.now() - v2Started;
    const v2WebhookUrl = v2.urls[0]?.url;
    if (!v2WebhookUrl) throw new Error("Second deploy returned no webhook URL");
    const v2DeploymentId = await deploymentIdAt(host);
    identities.v2DeploymentId = v2DeploymentId;
    identities.v2WorkerVersionId = await firstVersionId(cf, accountId, scriptName);
    if (JSON.stringify(v2.artifactVersions) !== JSON.stringify(expectedV2Artifacts)) {
      throw new Error("Second deploy returned unexpected workflow artifacts");
    }
    const v2ArtifactVersion = v2.artifactVersions[0]!;
    await verifyOwnedArtifact(v2ArtifactVersion);
    identities.artifactVersions = [v1ArtifactVersion, v2ArtifactVersion].sort((a, b) =>
      a.localeCompare(b),
    );

    const freshV2RunId = await trigger(v2WebhookUrl, {
      sleepMs: 0,
      expectedSecretHash: oldHash,
      rejectedSecretHash: newHash,
      printSecret: false,
    });
    const freshV2 = await waitFor(
      cf,
      accountId,
      scriptName,
      freshV2RunId,
      (details) => details.status === "complete",
      60_000,
    );
    assertOutput(freshV2, "v2", true, false);
    identities.v2PreRotationRunId = freshV2RunId;

    const rotationStarted = Date.now();
    await setScriptSecret(
      {
        workers: cf.workers,
      } as never,
      accountId,
      scriptName,
      "SMOKE_SECRET",
      newSecret,
    );
    timings.secretRotationApiMs = Date.now() - rotationStarted;
    const propagationStarted = Date.now();
    const propagationDeadline = propagationStarted + 180_000;
    const propagationRunIds: string[] = [];
    let rotated: InstanceDetails | undefined;
    let rotatedRunId: string | undefined;
    while (Date.now() < propagationDeadline && !rotated) {
      const propagationRunId = await trigger(v2WebhookUrl, {
        sleepMs: 0,
        expectedSecretHash: newHash,
        rejectedSecretHash: oldHash,
        printSecret: true,
      });
      propagationRunIds.push(propagationRunId);
      let propagation: InstanceDetails;
      try {
        propagation = await waitFor(
          cf,
          accountId,
          scriptName,
          propagationRunId,
          (details) => details.status === "complete",
          60_000,
        );
      } catch (error) {
        if (!String(error).includes("Durable Object reset because its code was updated")) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      const secret = JSON.parse(stepOutput(propagation, "secret-state")) as {
        matchesExpected?: unknown;
        matchesRejected?: unknown;
      };
      const execOutput = stepOutput(propagation, "secret-output");
      if (secretValues.some((secret) => execOutput.includes(secret))) {
        throw new Error("A raw secret appeared in managed command step output");
      }
      const exec = JSON.parse(execOutput) as {
        stdout?: unknown;
        stderr?: unknown;
        exitCode?: unknown;
      };
      if (
        typeof exec.stdout !== "string" ||
        exec.stdout.trimEnd() !== "***" ||
        exec.stderr !== "" ||
        exec.exitCode !== 0
      ) {
        throw new Error(`Unexpected redacted command output: ${JSON.stringify(exec)}`);
      }
      if (secret.matchesExpected === true && secret.matchesRejected === false) {
        rotated = propagation;
        rotatedRunId = propagationRunId;
      } else if (!(secret.matchesExpected === false && secret.matchesRejected === true)) {
        throw new Error(`Unexpected secret-state output: ${JSON.stringify(secret)}`);
      }
      if (!rotated) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    if (!rotated || !rotatedRunId) {
      throw new Error("No redacted run observed the rotated secret within 180 seconds");
    }
    timings.secretPropagationMs = Date.now() - propagationStarted;
    timings.rotatedRunMs = timings.secretPropagationMs;
    identities.secretPropagationRunIds = propagationRunIds;
    assertOutput(rotated, "v2", true, false);
    identities.v2PostRotationRunId = rotatedRunId;

    const oldCompleted = await waitFor(
      cf,
      accountId,
      scriptName,
      sleepingRunId,
      (details) => details.status === "complete",
      180_000,
    );
    timings.v1TotalRunMs = Date.now() - sleepingStarted;
    assertOutput(oldCompleted, "v1", true, false);
    const allObserved = JSON.stringify([sleeping, freshV2, rotated, oldCompleted]);
    if (secretValues.some((secret) => allObserved.includes(secret))) {
      throw new Error("A raw secret appeared in Workflow API output");
    }

    report = {
      outcome: "passed",
      accountId,
      bucketName,
      bucketCreated,
      identities,
      timings: { ...timings, totalMs: Date.now() - startedAt },
      readiness:
        "each deploy returned only after thirty-one matching cache-busted /.runway/version observations over thirty seconds",
      loaderEviction:
        "Cloudflare exposes no supported Worker Loader eviction control; live cold-loader recovery remains unforced",
      workersRuntimeMetadataProof:
        "packages/runway/tests/worker.test.ts: a Dynamic Workflow loads the exact artifact and declared secrets selected by its metadata",
      secretProof: {
        newRunMatchedNewOnly: true,
        managedOutput: "***",
        rawSecretObserved: false,
      },
      createdObjectKeys: [...createdObjectKeys].sort(),
    };
  } catch (error) {
    smokeError = error;
  } finally {
    const cleanupErrors: string[] = [];
    try {
      const application = (await containerApplications(token, accountId)).find(
        (candidate) => candidate.name === containerName,
      );
      if (application) await deleteContainer(token, accountId, application.id);
    } catch (error) {
      cleanupErrors.push(`container: ${String(error)}`);
    }
    try {
      const workflow = (await relatedWorkflows(cf, accountId, scriptName)).find(
        (candidate) => candidate.name === scriptName,
      );
      if (workflow?.scriptName === scriptName) {
        await cf.workflows.delete(scriptName, { account_id: accountId });
      } else if (workflow) {
        cleanupErrors.push(
          `refusing to delete Workflow ${workflow.name} owned by Worker ${workflow.scriptName ?? "<unknown>"}`,
        );
      }
    } catch (error) {
      if (!isStatus(error, 404)) cleanupErrors.push(`workflow: ${String(error)}`);
    }
    try {
      await cf.workers.scripts.delete(scriptName, { account_id: accountId });
    } catch (error) {
      if (!isStatus(error, 404)) cleanupErrors.push(`worker: ${String(error)}`);
    }
    try {
      for (const key of createdObjectKeys) {
        await cf.r2.buckets.objects.delete(bucketName, key, { account_id: accountId });
      }
      if (
        bucketCreated &&
        (await bucketExists(cf, accountId, bucketName)) &&
        (await objectKeys(cf, accountId, bucketName)).size === 0
      ) {
        await cf.r2.buckets.delete(bucketName, { account_id: accountId });
      }
    } catch (error) {
      cleanupErrors.push(`R2 objects: ${String(error)}`);
    }
    await rm(project, { recursive: true, force: true });

    try {
      const remainingContainer = (await containerApplications(token, accountId)).some(
        (candidate) => candidate.name === containerName,
      );
      const remainingScripts = await matchingScripts(cf, accountId, scriptName);
      const remainingWorkflows = await relatedWorkflows(cf, accountId, scriptName);
      const bucketRemains = await bucketExists(cf, accountId, bucketName);
      const remainingKeys = bucketRemains
        ? await objectKeys(cf, accountId, bucketName)
        : new Set<string>();
      if (remainingContainer) cleanupErrors.push(`container still exists: ${containerName}`);
      if (remainingScripts.length > 0) cleanupErrors.push(`Worker still exists: ${scriptName}`);
      if (remainingWorkflows.length > 0) cleanupErrors.push(`Workflow still exists: ${scriptName}`);
      for (const key of createdObjectKeys) {
        if (remainingKeys.has(key)) cleanupErrors.push(`R2 object still exists: ${key}`);
      }
      if (bucketCreated && bucketRemains && remainingKeys.size === 0) {
        cleanupErrors.push(`empty smoke-created R2 bucket still exists: ${bucketName}`);
      }
    } catch (error) {
      cleanupErrors.push(`verification: ${String(error)}`);
    }

    if (cleanupErrors.length > 0) {
      const sanitized = cleanupErrors
        .join("; ")
        .replaceAll(hookSecret, "***")
        .replaceAll(oldSecret, "***")
        .replaceAll(newSecret, "***");
      cleanupError = new Error(`Smoke cleanup failed: ${sanitized}`, { cause: smokeError });
    }
  }

  if (cleanupError) throw cleanupError;
  if (smokeError) throw smokeError;
  if (!report) throw new Error("Smoke completed without a report");
  console.log(JSON.stringify(report, null, 2));
};

await run().catch((error) => {
  const message = (error instanceof Error ? (error.stack ?? error.message) : String(error))
    .replaceAll(hookSecret, "***")
    .replaceAll(oldSecret, "***")
    .replaceAll(newSecret, "***");
  console.error(message);
  process.exitCode = 1;
});
