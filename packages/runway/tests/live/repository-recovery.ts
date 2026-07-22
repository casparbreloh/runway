// fallow-ignore-file code-duplication -- public recovery independently proves the same contract as authenticated recovery

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import Cloudflare, { toFile } from "cloudflare";
import { webhook, workflow } from "runway";

import { buildDeployment } from "../../src/internal/publish/artifacts.ts";
import { publishWithAdapters } from "../../src/internal/publish/publish.ts";
import type { Registry } from "../../src/internal/publish/registry.ts";
import { workflowArtifactKey } from "../../src/internal/runtime/artifact.ts";
import { DATA_BUCKET } from "../../src/internal/runtime/contract.ts";
import { COMPATIBILITY_DATE } from "../../src/internal/runtime/contract.ts";
import { resolveRepositorySource } from "../../src/internal/source/repository.ts";
import {
  cloudflareAccountId,
  cloudflareStatusIs,
  cloudflareToken,
  containerApplications,
  deleteContainer,
  matchingScripts,
  nonGitHubDeployEnv,
  r2BucketExists,
  r2ObjectExists,
  r2ObjectKeys,
  relatedWorkflows,
  triggerSignedWebhook,
  waitForWorkflow,
  workflowStepOutput,
} from "./support.ts";

const WORKFLOW_ID = "repository-recovery-smoke";
const WEBHOOK_PATH = "/smoke";
const SIGNATURE_HEADER = "x-smoke-signature";
const SECRET_NAMES = ["HOOK_SECRET", "DRIVER_TOKEN"] as const;
const hookSecret = `hook-${randomUUID()}`;
const driverToken = `driver-${randomUUID()}`;

interface SmokeEvent {
  readonly destroyUrl: string;
}

interface InstanceDetails {
  readonly status: string;
  readonly steps: ReadonlyArray<{
    readonly type: string;
    readonly name?: string;
    readonly output?: string | null;
  }>;
}

interface CheckoutMetrics {
  readonly commit: string;
  readonly generation: number;
  readonly prepareStartedAtMs: number;
  readonly sandboxReadyAtMs: number;
  readonly startedAtMs: number;
  readonly fetchMs: number;
  readonly checkoutMs: number;
  readonly packBytes: number;
}

interface Observation {
  readonly head: string;
  readonly observedAtMs: number;
  readonly metrics: CheckoutMetrics;
}

const smokeDefinition = workflow({
  id: WORKFLOW_ID,
  secrets: SECRET_NAMES,
  trigger: (ctx) =>
    webhook<SmokeEvent>({
      path: WEBHOOK_PATH,
      secret: ctx.secrets.HOOK_SECRET,
      signatureHeader: SIGNATURE_HEADER,
    }),
}).run(async () => {});

const registry = (cwd: string): Registry => [
  {
    path: path.join(cwd, ".runway/workflows/smoke.ts"),
    exportName: "default",
    def: smokeDefinition,
  },
];

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const measurementCommand = (): string => {
  const source = `const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const metrics = JSON.parse(fs.readFileSync("/tmp/runway-repository-metrics", "utf8"));
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
process.stdout.write(JSON.stringify({ head, observedAtMs: Date.now(), metrics }));`;
  return `node -e ${shellQuote(source)}`;
};

const workflowSource = (): string => `
import { webhook, workflow } from "runway";

interface SmokeEvent {
  readonly destroyUrl: string;
}

const observe = (output: string) => JSON.parse(output);

export default workflow({
  id: ${JSON.stringify(WORKFLOW_ID)},
  secrets: ${JSON.stringify(SECRET_NAMES)},
  trigger: (ctx) => webhook<SmokeEvent>({
    path: ${JSON.stringify(WEBHOOK_PATH)},
    secret: ctx.secrets.HOOK_SECRET,
    signatureHeader: ${JSON.stringify(SIGNATURE_HEADER)},
  }),
}).run(async (run, event) => {
  const coldStartedAtMs = await run.do("cold-started", () => Date.now());
  const cold = observe((await run.exec("cold", ${JSON.stringify(measurementCommand())})).stdout);
  await run.do("cold-report", () => ({ coldStartedAtMs, cold }));
  await run.do("force-destroy", async () => {
    const response = await fetch(event.destroyUrl, {
      method: "POST",
      headers: {
        authorization: \`Bearer \${run.secrets.DRIVER_TOKEN}\`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ runId: run.runId }),
    });
    if (!response.ok) throw new Error(\`destroy driver returned \${response.status}\`);
    return await response.json();
  });
  const recoveryStartedAtMs = await run.do("recovery-started", () => Date.now());
  let loss;
  try {
    await run.exec("recovered", ${JSON.stringify(measurementCommand())});
    throw new Error("destroyed placement unexpectedly replayed a user command");
  } catch (error) {
    loss = {
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  await run.do("loss-report", () => ({ recoveryStartedAtMs, loss }));
});
`;

const driverSource = (): string => `
const hex = (bytes) => [...new Uint8Array(bytes)]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");

const sandboxId = async (runId) => {
  const bytes = new TextEncoder().encode(runId);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return \`runway-\${hex(digest).slice(0, 32)}\`;
};

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (request.headers.get("authorization") !== \`Bearer \${env.DRIVER_TOKEN}\`) {
      return new Response("unauthorized", { status: 401 });
    }
    const body = await request.json();
    if (!body || typeof body.runId !== "string") {
      return new Response("invalid run id", { status: 400 });
    }
    const id = env.RUNWAY_SANDBOX.idFromName(await sandboxId(body.runId));
    await env.RUNWAY_SANDBOX.get(id).destroy();
    return Response.json({ destroyed: true });
  },
};
`;

const uploadDriver = async (
  cf: Cloudflare,
  accountId: string,
  driverName: string,
  scriptName: string,
): Promise<void> => {
  await cf.workers.scripts.update(driverName, {
    account_id: accountId,
    metadata: {
      main_module: "worker.js",
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [
        { type: "secret_text", name: "DRIVER_TOKEN", text: driverToken },
        {
          type: "durable_object_namespace",
          name: "RUNWAY_SANDBOX",
          class_name: "Sandbox",
          script_name: scriptName,
        },
      ],
    },
    files: [
      await toFile(new TextEncoder().encode(driverSource()), "worker.js", {
        type: "application/javascript+module",
      }),
    ],
  });
  await cf.workers.scripts.subdomain.create(driverName, {
    account_id: accountId,
    enabled: true,
  });
};

const observationOf = (value: unknown): Observation => {
  if (!value || typeof value !== "object") throw new Error("invalid smoke observation");
  const observation = value as Observation;
  const metrics = observation.metrics;
  if (
    typeof observation.head !== "string" ||
    typeof observation.observedAtMs !== "number" ||
    !metrics ||
    typeof metrics.commit !== "string" ||
    typeof metrics.generation !== "number" ||
    typeof metrics.prepareStartedAtMs !== "number" ||
    typeof metrics.sandboxReadyAtMs !== "number" ||
    typeof metrics.startedAtMs !== "number" ||
    typeof metrics.fetchMs !== "number" ||
    typeof metrics.checkoutMs !== "number" ||
    typeof metrics.packBytes !== "number"
  ) {
    throw new Error("invalid smoke observation");
  }
  return observation;
};

const run = async (): Promise<void> => {
  const startedAt = Date.now();
  const suffix = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
  const scriptName = process.env.RUNWAY_SMOKE_SCRIPT ?? `runway-recovery-smoke-${suffix}`;
  const driverName = `${scriptName}-driver`;
  const containerName = scriptName;
  const token = await cloudflareToken(false);
  const cf = new Cloudflare({ apiToken: token });
  const accountId = await cloudflareAccountId(cf);
  const bucketName = DATA_BUCKET;
  const bucketExisted = await r2BucketExists(cf, accountId, bucketName);
  const scriptNames = new Set([scriptName, driverName]);
  const collisions = [
    ...(await matchingScripts(cf, accountId, scriptNames)).map((name) => `Worker ${name}`),
    ...(await relatedWorkflows(cf, accountId, scriptName)).map(
      (candidate) => `Workflow ${candidate.name}`,
    ),
    ...(await containerApplications(token, accountId))
      .filter((candidate) => candidate.name === containerName)
      .map((candidate) => `container ${candidate.name}`),
  ];
  if (collisions.length > 0) {
    throw new Error(`Refusing to overwrite pre-existing smoke resources: ${collisions.join(", ")}`);
  }
  const project = await mkdtemp(
    path.join(path.resolve(import.meta.dirname, ".."), ".tmp-recovery-smoke-"),
  );
  const workflowPath = path.join(project, ".runway/workflows/smoke.ts");
  const createdObjectKeys = new Set<string>();
  let smokeError: unknown;
  let cleanupError: Error | undefined;
  let report: Record<string, unknown> | undefined;
  let removeStack: (() => Promise<void>) | undefined;

  try {
    await mkdir(path.dirname(workflowPath), { recursive: true });
    await writeFile(path.join(project, "package.json"), JSON.stringify({ name: scriptName }));
    await writeFile(workflowPath, workflowSource());
    const repository = await resolveRepositorySource(project);
    const prepared = await buildDeployment(registry(project), {
      accountId,
      cwd: project,
      deploymentName: scriptName,
      repository,
      snapshotKeyAvailable: false,
    });
    for (const artifact of prepared.artifacts) {
      const key = workflowArtifactKey(artifact.artifactVersion);
      if (await r2ObjectExists(cf, accountId, bucketName, key)) {
        throw new Error(`Refusing to overwrite pre-existing smoke object: ${key}`);
      }
      createdObjectKeys.add(key);
    }
    const deployment = await publishWithAdapters(
      registry(project),
      {
        cwd: project,
        env: nonGitHubDeployEnv(process.env, {
          HOOK_SECRET: hookSecret,
          DRIVER_TOKEN: driverToken,
        }),
      },
      { deploymentName: scriptName },
    );
    removeStack = deployment.remove;
    if (
      JSON.stringify(deployment.artifactVersions) !==
      JSON.stringify(prepared.artifacts.map(({ artifactVersion }) => artifactVersion))
    ) {
      throw new Error("Publication returned unexpected workflow artifacts");
    }
    const webhookUrl = deployment.urls[0]?.url;
    if (!webhookUrl) throw new Error("Publication returned no webhook URL");
    await uploadDriver(cf, accountId, driverName, scriptName);
    const host = new URL(webhookUrl).host;
    const prefix = `${scriptName}.`;
    if (!host.startsWith(prefix)) throw new Error(`Unexpected webhook host: ${host}`);
    const destroyUrl = `https://${driverName}.${host.slice(prefix.length)}/destroy`;
    const runId = await triggerSignedWebhook(
      webhookUrl,
      { destroyUrl },
      hookSecret,
      SIGNATURE_HEADER,
    );
    const completed = await waitForWorkflow(
      cf,
      accountId,
      scriptName,
      runId,
      (details: InstanceDetails) => details.status === "complete",
      180_000,
    );
    const coldReport = JSON.parse(workflowStepOutput(completed, "cold-report")) as {
      coldStartedAtMs?: unknown;
      cold?: unknown;
    };
    const lossReport = JSON.parse(workflowStepOutput(completed, "loss-report")) as {
      recoveryStartedAtMs?: unknown;
      loss?: { name?: unknown; message?: unknown };
    };
    if (
      typeof coldReport.coldStartedAtMs !== "number" ||
      typeof lossReport.recoveryStartedAtMs !== "number" ||
      lossReport.loss?.name !== "RunLostError" ||
      typeof lossReport.loss.message !== "string" ||
      !lossReport.loss.message.includes("continuity was lost")
    ) {
      throw new Error(`Smoke did not report honest placement loss: ${JSON.stringify(lossReport)}`);
    }
    const cold = observationOf(coldReport.cold);
    if (cold.head !== cold.metrics.commit) {
      throw new Error("The cold command observed a checkout other than the pinned commit");
    }
    if (
      cold.metrics.prepareStartedAtMs > cold.metrics.sandboxReadyAtMs ||
      cold.metrics.sandboxReadyAtMs > cold.metrics.startedAtMs ||
      cold.metrics.startedAtMs > cold.observedAtMs
    ) {
      throw new Error("Checkout timing boundaries were not monotonic");
    }
    if (cold.metrics.packBytes <= 0) throw new Error("Checkout reported no pack bytes");
    report = {
      outcome: "passed",
      accountId,
      scriptName,
      driverName,
      runId,
      commit: cold.head,
      cold: {
        workflowToSandboxMs: cold.metrics.prepareStartedAtMs - coldReport.coldStartedAtMs,
        sandboxReadyMs: cold.metrics.sandboxReadyAtMs - cold.metrics.prepareStartedAtMs,
        checkoutProcessStartMs: cold.metrics.startedAtMs - cold.metrics.sandboxReadyAtMs,
        checkoutMs: cold.metrics.checkoutMs,
        fetchMs: cold.metrics.fetchMs,
        packBytes: cold.metrics.packBytes,
        commandReadyMs: cold.observedAtMs - cold.metrics.prepareStartedAtMs,
      },
      recovery: {
        state: "lost",
        detectedMs: Date.now() - lossReport.recoveryStartedAtMs,
      },
      totalMs: Date.now() - startedAt,
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
    for (const name of [driverName, scriptName]) {
      try {
        await cf.workers.scripts.delete(name, { account_id: accountId });
      } catch (error) {
        if (!cloudflareStatusIs(error, 404)) cleanupErrors.push(`${name}: ${String(error)}`);
      }
    }
    try {
      await cf.workflows.delete(scriptName, { account_id: accountId });
    } catch (error) {
      if (!cloudflareStatusIs(error, 404)) cleanupErrors.push(`workflow: ${String(error)}`);
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
      for (const key of createdObjectKeys) {
        await cf.r2.buckets.objects.delete(key, { account_id: accountId, bucket_name: bucketName });
      }
      if (!bucketExisted && (await r2ObjectKeys(cf, accountId, bucketName)).size === 0) {
        await cf.r2.buckets.delete(bucketName, { account_id: accountId });
      }
    } catch (error) {
      cleanupErrors.push(`R2: ${String(error)}`);
    }
    await rm(project, { recursive: true, force: true });
    try {
      const remainingScripts = await matchingScripts(cf, accountId, scriptNames);
      const remainingWorkflows = await relatedWorkflows(cf, accountId, scriptName);
      const remainingContainer = (await containerApplications(token, accountId)).some(
        (candidate) => candidate.name === containerName,
      );
      const bucketRemains = await r2BucketExists(cf, accountId, bucketName);
      const remainingKeys = bucketRemains
        ? await r2ObjectKeys(cf, accountId, bucketName)
        : new Set<string>();
      for (const name of remainingScripts) cleanupErrors.push(`Worker still exists: ${name}`);
      for (const workflow of remainingWorkflows) {
        cleanupErrors.push(`Workflow still exists: ${workflow.name}`);
      }
      if (remainingContainer) cleanupErrors.push(`container still exists: ${containerName}`);
      for (const key of createdObjectKeys) {
        if (remainingKeys.has(key)) cleanupErrors.push(`R2 object still exists: ${key}`);
      }
      if (!bucketExisted && bucketRemains && remainingKeys.size === 0) {
        cleanupErrors.push(`empty smoke-created R2 bucket still exists: ${bucketName}`);
      }
    } catch (error) {
      cleanupErrors.push(`verification: ${String(error)}`);
    }
    if (cleanupErrors.length > 0) {
      cleanupError = new Error(`Smoke cleanup failed: ${cleanupErrors.join("; ")}`, {
        cause: smokeError,
      });
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
    .replaceAll(driverToken, "***");
  console.error(message);
  process.exitCode = 1;
});
