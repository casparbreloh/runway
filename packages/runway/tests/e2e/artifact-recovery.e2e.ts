import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import Cloudflare from "cloudflare";
import { webhook, workflow } from "runway";

import { buildDeployment } from "../../src/internal/publish/artifacts.ts";
import { publishWithAdapters } from "../../src/internal/publish/publish.ts";
import { workflowArtifactKey } from "../../src/internal/runtime/artifact.ts";
import { DATA_BUCKET } from "../../src/internal/runtime/contract.ts";
import { setScriptSecret } from "../../src/internal/secret/store.ts";
import { resolveRepositorySource } from "../../src/internal/source/repository.ts";
import { artifactWorkflowSource } from "./artifact-fixture.ts";
import {
  cloudflareAccountId as oneAccountId,
  cloudflareStatusIs as isStatus,
  cloudflareToken as tokenOf,
  containerApplications,
  deleteContainer,
  matchingScripts,
  nonGitHubDeployEnv,
  r2BucketExists as bucketExists,
  r2ObjectExists as objectExists,
  r2ObjectKeys as objectKeys,
  relatedWorkflows,
  triggerSignedWebhook,
  waitForWorkflow,
  workflowStepOutput as stepOutput,
} from "./support.ts";
import { fixtureRegistry, writeWorkflowFixture } from "./workflow-fixture.ts";

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
}).run(async () => {});

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const ensureArtifactBucket = async (
  cf: Cloudflare,
  accountId: string,
  bucketName: string,
): Promise<boolean> => {
  if (await bucketExists(cf, accountId, bucketName)) return false;
  await cf.r2.buckets.create({ account_id: accountId, name: bucketName });
  return true;
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

const run = async (): Promise<void> => {
  const startedAt = Date.now();
  const suffix = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
  const scriptName = process.env.RUNWAY_SMOKE_SCRIPT ?? `runway-artifact-smoke-${suffix}`;
  const containerName = scriptName;
  const token = await tokenOf();
  const cf = new Cloudflare({ apiToken: token, timeout: 15_000 });
  const accountId = await oneAccountId(cf, true);
  const bucketName = DATA_BUCKET;
  const collisions = [
    ...(await matchingScripts(cf, accountId, new Set([scriptName]))).map(
      (name) => `Worker ${name}`,
    ),
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
  let removeStack: (() => Promise<void>) | undefined;
  let report: Record<string, unknown> | undefined;
  let bucketCreated = false;

  try {
    bucketCreated = await ensureArtifactBucket(cf, accountId, bucketName);
    await writeWorkflowFixture(project, scriptName, artifactWorkflowSource("v1", scriptName));
    const repository = await resolveRepositorySource(project);
    console.log(JSON.stringify({ phase: "start", accountId, scriptName, bucketName }));
    const preparedV1 = await buildDeployment(fixtureRegistry(project, smokeDefinition), {
      accountId,
      cwd: project,
      deploymentName: scriptName,
      repository,
      snapshotKeyAvailable: true,
    });
    const expectedV1Artifacts = preparedV1.artifacts.map(({ artifactVersion }) => artifactVersion);
    await ownPreparedArtifacts(expectedV1Artifacts);
    const v1Started = Date.now();
    const v1 = await publishWithAdapters(
      fixtureRegistry(project, smokeDefinition),
      {
        cwd: project,
        env: nonGitHubDeployEnv(process.env, {
          HOOK_SECRET: hookSecret,
          SMOKE_SECRET: oldSecret,
        }),
      },
      { deploymentName: scriptName },
    );
    removeStack = v1.remove;
    timings.v1PublishMs = Date.now() - v1Started;
    const webhookUrl = v1.urls[0]?.url;
    if (!webhookUrl) throw new Error("Publication returned no webhook URL");
    const host = new URL(webhookUrl).host;
    const v1DeploymentId = await deploymentIdAt(host);
    identities.v1DeploymentId = v1DeploymentId;
    identities.v1WorkerVersionId = await firstVersionId(cf, accountId, scriptName);
    if (JSON.stringify(v1.artifactVersions) !== JSON.stringify(expectedV1Artifacts)) {
      throw new Error("First publication returned unexpected workflow artifacts");
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
        publishMs: timings.v1PublishMs,
      }),
    );

    const oldHash = sha256(oldSecret);
    const newHash = sha256(newSecret);
    const sleepingStarted = Date.now();
    const sleepingRunId = await triggerSignedWebhook(
      webhookUrl,
      {
        sleepMs: 180_000,
        expectedSecretHash: oldHash,
        rejectedSecretHash: newHash,
        printSecret: false,
      },
      hookSecret,
      "x-smoke-signature",
    );
    const sleeping = await waitForWorkflow(
      cf,
      accountId,
      scriptName,
      sleepingRunId,
      (details: InstanceDetails) =>
        ["running", "waiting"].includes(details.status) &&
        details.steps.some(
          (step) =>
            step.type === "sleep" &&
            (step.name === "hold-v1" || step.name?.startsWith("hold-v1-") === true) &&
            !step.finished,
        ),
      60_000,
      (diagnostic) =>
        secretValues.reduce((value, secret) => value.replaceAll(secret, "***"), diagnostic),
    );
    timings.v1ReachedSleepMs = Date.now() - sleepingStarted;
    identities.v1SleepingRunId = sleepingRunId;
    identities.v1StatusBeforeRedeploy = sleeping.status;

    await writeFile(workflowPath, artifactWorkflowSource("v2", scriptName));
    const preparedV2 = await buildDeployment(fixtureRegistry(project, smokeDefinition), {
      accountId,
      cwd: project,
      deploymentName: scriptName,
      repository,
      snapshotKeyAvailable: true,
    });
    const expectedV2Artifacts = preparedV2.artifacts.map(({ artifactVersion }) => artifactVersion);
    await ownPreparedArtifacts(expectedV2Artifacts);
    const v2Started = Date.now();
    const v2 = await publishWithAdapters(
      fixtureRegistry(project, smokeDefinition),
      {
        cwd: project,
        env: nonGitHubDeployEnv(process.env, {
          HOOK_SECRET: hookSecret,
          SMOKE_SECRET: oldSecret,
        }),
      },
      { deploymentName: scriptName },
    );
    removeStack = v2.remove;
    timings.v2PublishMs = Date.now() - v2Started;
    const v2WebhookUrl = v2.urls[0]?.url;
    if (!v2WebhookUrl) throw new Error("Second publication returned no webhook URL");
    const v2DeploymentId = await deploymentIdAt(host);
    identities.v2DeploymentId = v2DeploymentId;
    identities.v2WorkerVersionId = await firstVersionId(cf, accountId, scriptName);
    if (JSON.stringify(v2.artifactVersions) !== JSON.stringify(expectedV2Artifacts)) {
      throw new Error("Second publication returned unexpected workflow artifacts");
    }
    const v2ArtifactVersion = v2.artifactVersions[0]!;
    await verifyOwnedArtifact(v2ArtifactVersion);
    identities.artifactVersions = [v1ArtifactVersion, v2ArtifactVersion].sort((a, b) =>
      a.localeCompare(b),
    );

    const freshV2RunId = await triggerSignedWebhook(
      v2WebhookUrl,
      {
        sleepMs: 0,
        expectedSecretHash: oldHash,
        rejectedSecretHash: newHash,
        printSecret: false,
      },
      hookSecret,
      "x-smoke-signature",
    );
    const freshV2 = await waitForWorkflow(
      cf,
      accountId,
      scriptName,
      freshV2RunId,
      (details: InstanceDetails) => details.status === "complete",
      60_000,
      (diagnostic) =>
        secretValues.reduce((value, secret) => value.replaceAll(secret, "***"), diagnostic),
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
      const propagationRunId = await triggerSignedWebhook(
        v2WebhookUrl,
        {
          sleepMs: 0,
          expectedSecretHash: newHash,
          rejectedSecretHash: oldHash,
          printSecret: true,
        },
        hookSecret,
        "x-smoke-signature",
      );
      propagationRunIds.push(propagationRunId);
      let propagation: InstanceDetails;
      try {
        propagation = await waitForWorkflow(
          cf,
          accountId,
          scriptName,
          propagationRunId,
          (details: InstanceDetails) => details.status === "complete",
          60_000,
          (diagnostic) =>
            secretValues.reduce((value, secret) => value.replaceAll(secret, "***"), diagnostic),
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
        result?: {
          stdout?: unknown;
          stderr?: unknown;
          exitCode?: unknown;
        };
      };
      if (
        typeof exec.result?.stdout !== "string" ||
        exec.result.stdout.trimEnd() !== "***" ||
        exec.result.stderr !== "" ||
        exec.result.exitCode !== 0
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

    const oldCompleted = await waitForWorkflow(
      cf,
      accountId,
      scriptName,
      sleepingRunId,
      (details: InstanceDetails) => details.status === "complete",
      180_000,
      (diagnostic) =>
        secretValues.reduce((value, secret) => value.replaceAll(secret, "***"), diagnostic),
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
        "each publication returned only after thirty-one matching cache-busted /.runway/version observations over thirty seconds",
      loaderEviction:
        "Cloudflare exposes no supported Worker Loader eviction control; live cold-loader recovery remains unforced",
      workersRuntimeMetadataProof:
        "packages/runway/tests/runtime.workers.test.ts: a Dynamic Workflow loads the exact artifact and declared secrets selected by its metadata",
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
      await removeStack?.();
    } catch (error) {
      cleanupErrors.push(`Stack: ${String(error)}`);
    }
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
        await cf.r2.buckets.objects.delete(key, { account_id: accountId, bucket_name: bucketName });
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
      const remainingScripts = await matchingScripts(cf, accountId, new Set([scriptName]));
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
