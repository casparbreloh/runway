import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import Cloudflare from "cloudflare";
import { webhook, workflow } from "runway";

import { createGitHubProvider } from "../../src/internal/github/provider.ts";
import { buildDeployment } from "../../src/internal/publish/artifacts.ts";
import { publishWithAdapters } from "../../src/internal/publish/publish.ts";
import { workflowArtifactKey } from "../../src/internal/runtime/artifact.ts";
import { DATA_BUCKET } from "../../src/internal/runtime/contract.ts";
import {
  GITHUB_APP_ID_BINDING,
  GITHUB_PRIVATE_KEY_BINDING,
} from "../../src/internal/runtime/contract.ts";
import { GITHUB_COORDINATOR_CLASS, SANDBOX_CLASS } from "../../src/internal/sandbox/config.ts";
import {
  githubRepositoryRemote,
  resolveRepositorySource,
} from "../../src/internal/source/repository.ts";
import type { RepositorySource } from "../../src/internal/source/repository.ts";
import {
  RECOVERY_SECRET_NAMES,
  RECOVERY_SIGNATURE_HEADER,
  RECOVERY_WEBHOOK_PATH,
  recoveryWorkflowSource,
  uploadRecoveryDriver,
} from "./recovery-fixture.ts";
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
import { fixtureRegistry, writeWorkflowFixture } from "./workflow-fixture.ts";

const OPT_IN = "RUNWAY_LIVE_GITHUB_RECOVERY";
const REPOSITORY_ENV = "RUNWAY_LIVE_GITHUB_REPOSITORY";
const SHA_ENV = "RUNWAY_LIVE_GITHUB_SHA";
const WORKFLOW_ID = "github-recovery-smoke";
const hookSecret = `hook-${randomUUID()}`;
const driverToken = `driver-${randomUUID()}`;
const githubTokenPattern = /\bgh[opsu]_[A-Za-z0-9_]{20,}\b/g;

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
  readonly authenticationTokenMinted: boolean;
  readonly prepareStartedAtMs: number;
  readonly sandboxReadyAtMs: number;
  readonly startedAtMs: number;
  readonly fetchMs: number;
  readonly checkoutMs: number;
  readonly packBytes: number;
}

interface Observation {
  readonly head: string;
  readonly placement?: string;
  readonly observedAtMs: number;
  readonly authEnvironmentClean?: boolean;
  readonly metrics: CheckoutMetrics;
}

interface LiveConfig {
  readonly appId: string;
  readonly privateKey: string;
  readonly repositoryName: string;
  readonly sha: string;
}

interface DurableNamespace {
  readonly id?: string;
  readonly className?: string;
  readonly name?: string;
  readonly script?: string;
}

const smokeDefinition = workflow({
  id: WORKFLOW_ID,
  secrets: RECOVERY_SECRET_NAMES,
  trigger: (ctx) =>
    webhook<SmokeEvent>({
      path: RECOVERY_WEBHOOK_PATH,
      secret: ctx.secrets.HOOK_SECRET,
      signatureHeader: RECOVERY_SIGNATURE_HEADER,
    }),
}).run(async () => {});

const liveConfig = (): LiveConfig | undefined => {
  if (process.env[OPT_IN] !== "1") {
    console.log(
      JSON.stringify(
        {
          outcome: "skipped",
          smoke: "github-recovery",
          reason: `Set ${OPT_IN}=1 and the documented GitHub App/repository credentials to run`,
          required: [
            GITHUB_APP_ID_BINDING,
            GITHUB_PRIVATE_KEY_BINDING,
            REPOSITORY_ENV,
            SHA_ENV,
            "Wrangler auth or CLOUDFLARE_API_TOKEN with Workers, Workflows, Containers, R2, and Durable Objects access",
          ],
        },
        null,
        2,
      ),
    );
    return undefined;
  }
  const values = {
    appId: process.env[GITHUB_APP_ID_BINDING],
    privateKey: process.env[GITHUB_PRIVATE_KEY_BINDING],
    repositoryName: process.env[REPOSITORY_ENV],
    sha: process.env[SHA_ENV],
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(
      ([name]) =>
        (({ appId: GITHUB_APP_ID_BINDING, privateKey: GITHUB_PRIVATE_KEY_BINDING }) as const)[
          name as "appId" | "privateKey"
        ] ?? (name === "repositoryName" ? REPOSITORY_ENV : SHA_ENV),
    );
  if (missing.length > 0)
    throw new Error(`Missing live GitHub recovery config: ${missing.join(", ")}`);
  if (!/^[1-9][0-9]*$/.test(values.appId!)) throw new Error("Invalid GitHub App ID");
  if (!/^[0-9a-f]{40}$/.test(values.sha!)) throw new Error(`Invalid ${SHA_ENV}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repositoryName!)) {
    throw new Error(`Invalid ${REPOSITORY_ENV}`);
  }
  return values as LiveConfig;
};

const durableNamespaces = async (
  cf: Cloudflare,
  accountId: string,
): Promise<ReadonlyArray<DurableNamespace>> => {
  const namespaces: DurableNamespace[] = [];
  for await (const namespace of cf.durableObjects.namespaces.list({ account_id: accountId })) {
    namespaces.push({
      ...(typeof namespace.id === "string" ? { id: namespace.id } : {}),
      ...(typeof namespace.class === "string" ? { className: namespace.class } : {}),
      ...(typeof namespace.name === "string" ? { name: namespace.name } : {}),
      ...(typeof namespace.script === "string" ? { script: namespace.script } : {}),
    });
  }
  return namespaces;
};

const namespaceNames = (scriptName: string): ReadonlySet<string> =>
  new Set([`${scriptName}_RunwayGitHubCoordinator`, `${scriptName}_Sandbox`]);

const relatedNamespaces = async (
  cf: Cloudflare,
  accountId: string,
  scriptName: string,
): Promise<ReadonlyArray<DurableNamespace>> => {
  const names = namespaceNames(scriptName);
  return (await durableNamespaces(cf, accountId)).filter(
    (namespace) => namespace.script === scriptName || (namespace.name && names.has(namespace.name)),
  );
};

const namespaceObjectCount = async (
  cf: Cloudflare,
  accountId: string,
  namespaceId: string,
): Promise<number> => {
  let count = 0;
  for await (const _object of cf.durableObjects.namespaces.objects.list(namespaceId, {
    account_id: accountId,
  })) {
    count += 1;
  }
  return count;
};

const waitForNamespaceAbsence = async (
  cf: Cloudflare,
  accountId: string,
  scriptName: string,
  createdIds: ReadonlySet<string>,
): Promise<ReadonlyArray<DurableNamespace>> => {
  const deadline = Date.now() + 30_000;
  let remaining: ReadonlyArray<DurableNamespace> = [];
  do {
    const namespaces = await durableNamespaces(cf, accountId);
    const names = namespaceNames(scriptName);
    remaining = namespaces.filter(
      (namespace) =>
        namespace.script === scriptName ||
        (namespace.name !== undefined && names.has(namespace.name)) ||
        (namespace.id !== undefined && createdIds.has(namespace.id)),
    );
    if (remaining.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  return remaining;
};

const observationOf = (value: unknown, authenticated: boolean): Observation => {
  if (!value || typeof value !== "object") throw new Error("invalid smoke observation");
  const observation = value as Observation;
  const metrics = observation.metrics;
  if (
    typeof observation.head !== "string" ||
    (authenticated &&
      (typeof observation.placement !== "string" ||
        observation.placement.length === 0 ||
        observation.authEnvironmentClean !== true)) ||
    typeof observation.observedAtMs !== "number" ||
    !metrics ||
    typeof metrics.commit !== "string" ||
    typeof metrics.generation !== "number" ||
    (authenticated && typeof metrics.authenticationTokenMinted !== "boolean") ||
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

const assertNoCredentialDiagnostics = (details: InstanceDetails, config: LiveConfig): void => {
  const diagnostics = JSON.stringify(details);
  const privateKeyBodies = config.privateKey
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("---"));
  const forbidden = [hookSecret, driverToken, config.privateKey, ...privateKeyBodies];
  if (forbidden.some((value) => value.length >= 8 && diagnostics.includes(value))) {
    throw new Error("Workflow diagnostics contained a configured credential");
  }
  if (githubTokenPattern.test(diagnostics) || /BEGIN (?:RSA )?PRIVATE KEY/.test(diagnostics)) {
    throw new Error("Workflow diagnostics contained GitHub credential material");
  }
};

const authenticatedSource = async (
  project: string,
  config: LiveConfig,
): Promise<{
  readonly source: RepositorySource;
  readonly installationId: number;
  readonly repositoryId: number;
}> => {
  const local = await resolveRepositorySource(project);
  if (local.commit !== config.sha) {
    throw new Error(`Local checkout SHA ${local.commit} does not match ${SHA_ENV}=${config.sha}`);
  }
  const resolved = await createGitHubProvider({
    appId: config.appId,
    privateKey: config.privateKey,
  }).resolveRepository(config.repositoryName);
  if (resolved.repository.fullName.toLowerCase() !== config.repositoryName.toLowerCase()) {
    throw new Error("GitHub App resolved an unexpected repository identity");
  }
  return {
    source: {
      remote: githubRepositoryRemote(resolved.repository),
      commit: config.sha,
      authentication: { type: "github", ...resolved },
    },
    installationId: resolved.installationId,
    repositoryId: resolved.repository.id,
  };
};

interface RecoveryContext {
  readonly startedAt: number;
  readonly project: string;
  readonly cf: Cloudflare;
  readonly accountId: string;
  readonly scriptName: string;
  readonly driverName: string;
  readonly runId: string;
  readonly token: string;
}

type RecoveryVariant =
  | {
      readonly type: "repository";
      readonly workflowId: "repository-recovery-smoke";
      readonly scriptPrefix: "runway-recovery-smoke";
      readonly temporaryPrefix: ".tmp-recovery-smoke-";
      readonly definition: typeof smokeDefinition;
      readonly source: (project: string) => Promise<RepositorySource>;
      readonly deployEnv: () => NodeJS.ProcessEnv;
      readonly report: (
        completed: InstanceDetails,
        context: RecoveryContext,
      ) => Record<string, unknown>;
    }
  | {
      readonly type: "github";
      readonly workflowId: typeof WORKFLOW_ID;
      readonly scriptPrefix: "runway-github-recovery";
      readonly temporaryPrefix: ".tmp-github-recovery-smoke-";
      readonly definition: typeof smokeDefinition;
      readonly config: LiveConfig;
      readonly source: (project: string) => Promise<RepositorySource>;
      readonly deployEnv: () => NodeJS.ProcessEnv;
      readonly report: (
        completed: InstanceDetails,
        context: RecoveryContext,
        namespaces: ReadonlyMap<string, DurableNamespace & { id: string }>,
      ) => Promise<Record<string, unknown>>;
    };

const definition = (id: string) =>
  workflow({
    id,
    secrets: RECOVERY_SECRET_NAMES,
    trigger: (ctx) =>
      webhook<SmokeEvent>({
        path: RECOVERY_WEBHOOK_PATH,
        secret: ctx.secrets.HOOK_SECRET,
        signatureHeader: RECOVERY_SIGNATURE_HEADER,
      }),
  }).run(async () => {});

const repositoryVariant = (): RecoveryVariant => ({
  type: "repository",
  workflowId: "repository-recovery-smoke",
  scriptPrefix: "runway-recovery-smoke",
  temporaryPrefix: ".tmp-recovery-smoke-",
  definition: definition("repository-recovery-smoke"),
  source: resolveRepositorySource,
  deployEnv: () =>
    nonGitHubDeployEnv(process.env, { HOOK_SECRET: hookSecret, DRIVER_TOKEN: driverToken }),
  report: (completed, { accountId, scriptName, driverName, runId, startedAt }) => {
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
    const cold = observationOf(coldReport.cold, false);
    if (cold.head !== cold.metrics.commit) {
      throw new Error("The cold command observed a checkout other than the pinned commit");
    }
    assertCheckoutMetrics(cold);
    return {
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
      recovery: { state: "lost", detectedMs: Date.now() - lossReport.recoveryStartedAtMs },
      totalMs: Date.now() - startedAt,
    };
  },
});

const githubVariant = (config: LiveConfig): RecoveryVariant => {
  let identity: Awaited<ReturnType<typeof authenticatedSource>>;
  return {
    type: "github",
    workflowId: WORKFLOW_ID,
    scriptPrefix: "runway-github-recovery",
    temporaryPrefix: ".tmp-github-recovery-smoke-",
    definition: smokeDefinition,
    config,
    source: async (project) => (identity = await authenticatedSource(project, config)).source,
    deployEnv: () => ({
      ...process.env,
      HOOK_SECRET: hookSecret,
      DRIVER_TOKEN: driverToken,
      [GITHUB_APP_ID_BINDING]: config.appId,
      [GITHUB_PRIVATE_KEY_BINDING]: config.privateKey,
    }),
    report: async (completed, context, namespaces) => {
      const cold = observationOf(JSON.parse(workflowStepOutput(completed, "cold-report")), true);
      const destroyed = JSON.parse(workflowStepOutput(completed, "force-destroy")) as {
        placement?: unknown;
      };
      const recovered = JSON.parse(workflowStepOutput(completed, "recovered")) as {
        lost?: { message?: unknown; attempt?: unknown };
        result?: unknown;
        timeout?: unknown;
      };
      const lossReport = JSON.parse(workflowStepOutput(completed, "loss-report")) as {
        loss?: { name?: unknown; message?: unknown };
        replacementPlacement?: unknown;
      };
      const initialPlacement = destroyed.placement;
      if (
        typeof initialPlacement !== "string" ||
        initialPlacement.length === 0 ||
        recovered.result !== undefined ||
        recovered.timeout !== undefined ||
        recovered.lost?.attempt !== 1 ||
        typeof recovered.lost.message !== "string" ||
        !recovered.lost.message.includes("continuity was lost") ||
        lossReport.loss?.name !== "RunLostError" ||
        typeof lossReport.loss.message !== "string" ||
        !lossReport.loss.message.includes("continuity was lost") ||
        lossReport.replacementPlacement !== null
      )
        throw new Error("Authenticated smoke did not report honest placement loss");
      if (cold.head !== config.sha || cold.metrics.commit !== config.sha) {
        throw new Error("The cold command observed a checkout other than the opted-in exact SHA");
      }
      assertCheckoutMetrics(cold);
      if (cold.metrics.generation !== 1 || !cold.metrics.authenticationTokenMinted) {
        throw new Error(
          "Initial authenticated checkout did not mint installation auth exactly once",
        );
      }
      if (
        completed.steps.some(
          ({ name }) =>
            typeof name === "string" &&
            (name.startsWith("reused") || name.startsWith("replacement-placement")),
        ) ||
        JSON.stringify({ recovered, lossReport }).includes("authenticationTokenMinted")
      )
        throw new Error("A command or authenticated checkout ran after placement loss");
      assertNoCredentialDiagnostics(completed, config);
      const namespaceObjects = Object.fromEntries(
        await Promise.all(
          [SANDBOX_CLASS, GITHUB_COORDINATOR_CLASS].map(async (name) => {
            const namespace = namespaces.get(name)!;
            return [
              name,
              await namespaceObjectCount(context.cf, context.accountId, namespace.id),
            ] as const;
          }),
        ),
      );
      return {
        outcome: "passed",
        accountId: context.accountId,
        scriptName: context.scriptName,
        driverName: context.driverName,
        runId: context.runId,
        repository: config.repositoryName,
        repositoryId: identity.repositoryId,
        installationId: identity.installationId,
        sha: config.sha,
        initialPlacement,
        replacementPlacement: null,
        placementAfterDestroy: "unobserved",
        continuity: "lost",
        initialHostname: cold.placement,
        replacementHostname: null,
        tokenReminted: false,
        authenticationTokenMintEvidence: [cold.metrics.authenticationTokenMinted],
        loss: lossReport.loss,
        credentialDiagnosticsClean: true,
        durableNamespaces: Object.fromEntries(
          [SANDBOX_CLASS, GITHUB_COORDINATOR_CLASS].map((name) => [
            name,
            {
              id: namespaces.get(name)!.id,
              objectCountBeforeCleanup: namespaceObjects[name],
            },
          ]),
        ),
        cleanupScope: [
          "Worker-owned Sandbox and coordinator namespaces",
          "Dynamic Workflow and instances",
          "Sandbox container application",
          "artifact R2 object",
        ],
        totalMs: Date.now() - context.startedAt,
      };
    },
  };
};

const assertCheckoutMetrics = (observation: Observation): void => {
  const { metrics } = observation;
  if (
    metrics.prepareStartedAtMs > metrics.sandboxReadyAtMs ||
    metrics.sandboxReadyAtMs > metrics.startedAtMs ||
    metrics.startedAtMs > observation.observedAtMs
  ) {
    throw new Error("Checkout timing boundaries were not monotonic");
  }
  if (metrics.packBytes <= 0) throw new Error("Checkout reported no pack bytes");
};

const runRecoveryVariant = async (variant: RecoveryVariant): Promise<void> => {
  const startedAt = Date.now();
  const suffix = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
  const scriptName = process.env.RUNWAY_SMOKE_SCRIPT ?? `${variant.scriptPrefix}-${suffix}`;
  const driverName = `${scriptName}-driver`;
  const token = await cloudflareToken(variant.type === "github");
  const cf = new Cloudflare({
    apiToken: token,
    ...(variant.type === "github" ? { timeout: 15_000 } : {}),
  });
  const accountId = await cloudflareAccountId(cf);
  const bucketExisted = await r2BucketExists(cf, accountId, DATA_BUCKET);
  const scriptNames = new Set([scriptName, driverName]);
  const existingNamespaces =
    variant.type === "github" ? await relatedNamespaces(cf, accountId, scriptName) : [];
  const collisions = [
    ...(await matchingScripts(cf, accountId, scriptNames)).map((name) => `Worker ${name}`),
    ...(await relatedWorkflows(cf, accountId, scriptName)).map(({ name }) => `Workflow ${name}`),
    ...(await containerApplications(token, accountId))
      .filter(({ name }) => name === scriptName)
      .map(({ name }) => `container ${name}`),
    ...existingNamespaces.map(
      (namespace) => `Durable Object namespace ${namespace.name ?? namespace.id ?? "<unknown>"}`,
    ),
  ];
  if (collisions.length)
    throw new Error(`Refusing to overwrite pre-existing smoke resources: ${collisions.join(", ")}`);
  const project = await mkdtemp(
    path.join(path.resolve(import.meta.dirname, ".."), variant.temporaryPrefix),
  );
  const createdObjectKeys = new Set<string>();
  const createdNamespaceIds = new Set<string>();
  let smokeError: unknown;
  let cleanupError: Error | undefined;
  let report: Record<string, unknown> | undefined;
  let removeStack: (() => Promise<void>) | undefined;
  try {
    await writeWorkflowFixture(
      project,
      scriptName,
      recoveryWorkflowSource({
        workflowId: variant.workflowId,
        authenticated: variant.type === "github",
      }),
    );
    const repository = await variant.source(project);
    const registry = fixtureRegistry(project, variant.definition);
    const prepared = await buildDeployment(registry, {
      accountId,
      cwd: project,
      deploymentName: scriptName,
      repository,
      snapshotKeyAvailable: false,
    });
    for (const artifact of prepared.artifacts) {
      const key = workflowArtifactKey(artifact.artifactVersion);
      if (await r2ObjectExists(cf, accountId, DATA_BUCKET, key))
        throw new Error(`Refusing to overwrite pre-existing smoke object: ${key}`);
      createdObjectKeys.add(key);
    }
    const deployment = await publishWithAdapters(
      registry,
      { cwd: project, env: variant.deployEnv() },
      { deploymentName: scriptName },
    );
    removeStack = deployment.remove;
    if (
      JSON.stringify(deployment.artifactVersions) !==
      JSON.stringify(prepared.artifacts.map(({ artifactVersion }) => artifactVersion))
    ) {
      throw new Error("Publication returned unexpected workflow artifacts");
    }
    const deployedNamespaces =
      variant.type === "github" ? await relatedNamespaces(cf, accountId, scriptName) : [];
    deployedNamespaces.forEach(({ id }) => {
      if (id) createdNamespaceIds.add(id);
    });
    const namespaceByClass = new Map(
      deployedNamespaces
        .filter(
          (n): n is DurableNamespace & { id: string; className: string } =>
            n.script === scriptName && typeof n.id === "string" && typeof n.className === "string",
        )
        .map((n) => [n.className, n]),
    );
    if (
      variant.type === "github" &&
      (deployedNamespaces.length !== 2 ||
        namespaceByClass.size !== 2 ||
        !namespaceByClass.has(SANDBOX_CLASS) ||
        !namespaceByClass.has(GITHUB_COORDINATOR_CLASS))
    ) {
      throw new Error("Deploy did not create exactly the owned Sandbox and coordinator namespaces");
    }
    const webhookUrl = deployment.urls[0]?.url;
    if (!webhookUrl) throw new Error("Publication returned no webhook URL");
    await uploadRecoveryDriver({
      cf,
      accountId,
      driverName,
      scriptName,
      driverToken,
      observePlacement: variant.type === "github",
    });
    const host = new URL(webhookUrl).host;
    const prefix = `${scriptName}.`;
    if (!host.startsWith(prefix)) throw new Error(`Unexpected webhook host: ${host}`);
    const runId = await triggerSignedWebhook(
      webhookUrl,
      { destroyUrl: `https://${driverName}.${host.slice(prefix.length)}/destroy` },
      hookSecret,
      RECOVERY_SIGNATURE_HEADER,
    );
    const completed = await waitForWorkflow(
      cf,
      accountId,
      scriptName,
      runId,
      (details: InstanceDetails) => details.status === "complete",
      180_000,
    );
    const context = { startedAt, project, cf, accountId, scriptName, driverName, runId, token };
    report = await variant.report(completed, context, namespaceByClass);
  } catch (error) {
    smokeError = error;
  } finally {
    const errors: string[] = [];
    try {
      await removeStack?.();
    } catch (error) {
      errors.push(`Stack: ${String(error)}`);
    }
    for (const name of [driverName, scriptName])
      try {
        await cf.workers.scripts.delete(name, {
          account_id: accountId,
          ...(variant.type === "github" && name === scriptName ? { force: true } : {}),
        });
      } catch (error) {
        if (!cloudflareStatusIs(error, 404)) errors.push(`${name}: ${String(error)}`);
      }
    try {
      await cf.workflows.delete(scriptName, { account_id: accountId });
    } catch (error) {
      if (!cloudflareStatusIs(error, 404)) errors.push(`workflow: ${String(error)}`);
    }
    try {
      const application = (await containerApplications(token, accountId)).find(
        ({ name }) => name === scriptName,
      );
      if (application) await deleteContainer(token, accountId, application.id);
    } catch (error) {
      errors.push(`container: ${String(error)}`);
    }
    try {
      if (variant.type === "repository" || (await r2BucketExists(cf, accountId, DATA_BUCKET))) {
        for (const key of createdObjectKeys)
          if (
            variant.type === "repository" ||
            (await r2ObjectExists(cf, accountId, DATA_BUCKET, key))
          )
            await cf.r2.buckets.objects.delete(key, {
              account_id: accountId,
              bucket_name: DATA_BUCKET,
            });
        if (!bucketExisted && (await r2ObjectKeys(cf, accountId, DATA_BUCKET)).size === 0)
          await cf.r2.buckets.delete(DATA_BUCKET, { account_id: accountId });
      }
    } catch (error) {
      errors.push(`R2: ${String(error)}`);
    }
    await rm(project, { recursive: true, force: true });
    try {
      for (const name of await matchingScripts(cf, accountId, scriptNames))
        errors.push(`Worker still exists: ${name}`);
      for (const { name } of await relatedWorkflows(cf, accountId, scriptName))
        errors.push(`Workflow still exists: ${name}`);
      if ((await containerApplications(token, accountId)).some(({ name }) => name === scriptName))
        errors.push(`container still exists: ${scriptName}`);
      if (variant.type === "github")
        for (const namespace of await waitForNamespaceAbsence(
          cf,
          accountId,
          scriptName,
          createdNamespaceIds,
        ))
          errors.push(
            `Durable Object namespace still exists: ${namespace.name ?? namespace.id ?? "<unknown>"}`,
          );
      const bucketRemains = await r2BucketExists(cf, accountId, DATA_BUCKET);
      const keys = bucketRemains
        ? await r2ObjectKeys(cf, accountId, DATA_BUCKET)
        : new Set<string>();
      for (const key of createdObjectKeys)
        if (keys.has(key)) errors.push(`R2 object still exists: ${key}`);
      if (!bucketExisted && bucketRemains && keys.size === 0)
        errors.push(`empty smoke-created R2 bucket still exists: ${DATA_BUCKET}`);
    } catch (error) {
      errors.push(`verification: ${String(error)}`);
    }
    if (errors.length)
      cleanupError = new Error(`Smoke cleanup failed: ${errors.join("; ")}`, { cause: smokeError });
  }
  if (cleanupError) throw cleanupError;
  if (smokeError) throw smokeError;
  if (!report) throw new Error("Smoke completed without a report");
  console.log(
    JSON.stringify(
      variant.type === "github"
        ? { ...report, cleanupVerified: true, durableNamespaceAbsenceVerified: true }
        : report,
      null,
      2,
    ),
  );
};

export type RecoveryRunnerOptions = { readonly type: "repository" } | { readonly type: "github" };

export const runRecovery = async (options: RecoveryRunnerOptions): Promise<void> => {
  const variant = recoveryVariant(options);
  if (variant) await dispatchRecovery(variant);
};

const recoveryVariant = (options: RecoveryRunnerOptions): RecoveryVariant | undefined => {
  if (options.type === "repository") return repositoryVariant();
  const config = liveConfig();
  return config && githubVariant(config);
};

const dispatchRecovery = async (variant: RecoveryVariant): Promise<void> => {
  await runRecoveryVariant(variant).catch((error) => {
    let message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const privateKey = variant.type === "github" ? variant.config.privateKey : undefined;
    for (const secret of [hookSecret, driverToken, privateKey].filter(
      (value): value is string => !!value,
    ))
      message = message.replaceAll(secret, "***");
    console.error(message.replace(githubTokenPattern, "***"));
    process.exitCode = 1;
  });
};
