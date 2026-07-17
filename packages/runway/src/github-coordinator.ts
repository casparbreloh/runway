import { DurableObject } from "cloudflare:workers";

import {
  parseFailureDiagnostic,
  sameFailureDiagnostic,
  type FailureDiagnostic,
} from "./diagnostic.ts";
import {
  createGitHubProvider,
  type GitHubAcceptedDelivery,
  type GitHubCheckOutput,
  type GitHubProvider,
  type GitHubRepository,
} from "./github.ts";
import { parseGitHubRunSource, type GitHubRunSource } from "./repository-source.ts";
import { parseFinalization, parseTerminalRecord } from "./terminal.ts";
import type { Finalization, TerminalRecord } from "./terminal.ts";

type GitHubLifecycleState = "in_progress";

const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const ALARM_BATCH_SIZE = 32;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60 * 1_000;
const PROGRESS_DELAY_MS = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const WORKFLOW_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RUN_ID = /^runway-github-([0-9a-f]{48})-([1-9][0-9]*)$/;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

const checkOutput = (diagnostic: FailureDiagnostic | null): GitHubCheckOutput | undefined => {
  if (!diagnostic) return undefined;
  const sections = [
    diagnostic.stdout ? `stdout\n${diagnostic.stdout}` : "",
    diagnostic.stderr ? `stderr\n${diagnostic.stderr}` : "",
  ].filter(Boolean);
  return { title: "Command failed", summary: sections.join("\n\n") };
};

const diagnosticOf = (value: unknown): FailureDiagnostic | null => {
  try {
    return parseFailureDiagnostic(value);
  } catch {
    return invariant();
  }
};

export interface GitHubWorkflowAdmission {
  readonly workflowId: string;
  readonly artifactVersion: string;
  readonly checkName: string;
}

export interface GitHubCoordinatorAdmission {
  readonly accountId: string;
  readonly delivery: GitHubAcceptedDelivery;
  readonly workflows: readonly GitHubWorkflowAdmission[];
}

export interface GitHubCoordinatorRun {
  readonly id: string;
  readonly workflow: string;
}

export interface GitHubCoordinatorLifecycle {
  readonly source: GitHubRunSource;
  readonly state: GitHubLifecycleState;
}

interface CoordinatorProvider extends GitHubProvider {}

interface WorkflowEffects {
  create(options: { readonly id: string; readonly params: unknown }): Promise<unknown>;
  status(id: string): Promise<unknown>;
  terminate(id: string): Promise<void>;
}

interface CoordinatorClock {
  now(): Promise<number>;
}

interface CoordinatorEnv {
  RUNWAY_GITHUB_APP_ID?: string;
  RUNWAY_GITHUB_PRIVATE_KEY?: string;
  RUNWAY_GITHUB_PROVIDER?: CoordinatorProvider;
  RUNWAY_GITHUB_WORKFLOW?: WorkflowEffects;
  RUNWAY_GITHUB_CLOCK?: CoordinatorClock;
  WORKFLOWS?: Workflow;
}

interface DeliveryRecord {
  readonly kind: "delivery" | "tombstone";
  readonly deliveryId: string;
  readonly expiresAt: number;
  readonly runs: readonly GitHubCoordinatorRun[];
}

type DesiredState = "queued" | "in_progress" | "success" | "failure" | "cancelled" | "skipped";

interface RunRecord {
  readonly kind: "run";
  readonly accountId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly artifactVersion: string;
  readonly checkName: string;
  readonly delivery: GitHubAcceptedDelivery;
  readonly activeKey: string;
  readonly generation: number;
  readonly expiresAt: number;
  terminal: TerminalRecord | null;
  terminalPublished: boolean;
  diagnostic: FailureDiagnostic | null;
  desired: DesiredState;
  preflightComplete: boolean;
  checkCreateAttempted: boolean;
  checkRunId: number | null;
  workflowCreateAttempted: boolean;
  workflowKnown: boolean;
  checkInProgressComplete: boolean;
  checkCompletionComplete: boolean;
  terminationComplete: boolean;
  checkCancellationComplete: boolean;
  retryCount: number;
  nextAttemptAt: number;
}

interface ActiveRecord {
  readonly kind: "active";
  readonly activeKey: string;
  readonly runId: string;
  readonly generation: number;
}

interface PendingRecord {
  readonly kind: "pending";
  readonly runId: string;
  readonly dueAt: number;
}

interface ExpiryRecord {
  readonly kind: "expiry";
  readonly deliveryId: string;
  readonly dueAt: number;
}

class DurableInvariantError extends Error {
  constructor() {
    super("invalid GitHub coordinator state");
    this.name = "DurableInvariantError";
  }
}

const invariant = (): never => {
  throw new DurableInvariantError();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) invariant();
}

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const parseGeneration = (value: unknown): number => (positiveInteger(value) ? value : invariant());

const parseNonnegativeInteger = (value: unknown): number =>
  nonnegativeInteger(value) ? value : invariant();

const parseString = (value: unknown, pattern?: RegExp): string =>
  typeof value === "string" && (pattern === undefined || pattern.test(value)) ? value : invariant();

const parseBoolean = (value: unknown): boolean =>
  typeof value === "boolean" ? value : invariant();

const terminalRecordOf = (value: unknown): TerminalRecord => {
  try {
    return parseTerminalRecord(value);
  } catch {
    return invariant();
  }
};

const finalizationOf = (value: unknown): Finalization => {
  try {
    return parseFinalization(value);
  } catch {
    return invariant();
  }
};

const WORKFLOW_STATUSES = [
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waitingForPause",
  "unknown",
] as const;

type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

const parseWorkflowStatus = (value: unknown): WorkflowStatus => {
  if (!isRecord(value) || !WORKFLOW_STATUSES.includes(value.status as WorkflowStatus)) {
    throw new Error("invalid Workflow status response");
  }
  return value.status as WorkflowStatus;
};

const workflowInstanceId = async (value: unknown): Promise<string> => {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new Error("invalid Workflow create response");
  }
  let id: unknown;
  try {
    id = await Reflect.get(value, "id");
  } catch {
    throw new Error("invalid Workflow create response");
  }
  if (typeof id !== "string") throw new Error("invalid Workflow create response");
  return id;
};

const workflowIsTerminal = (status: WorkflowStatus): boolean =>
  status === "errored" || status === "terminated" || status === "complete";

const parseRepository = (value: unknown): GitHubRepository => {
  assertRecord(value);
  if (!exactKeys(value, ["id", "name", "fullName"])) invariant();
  const id = parseGeneration(value.id);
  const name = parseString(value.name, REPOSITORY_PART);
  const fullName = parseString(value.fullName);
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !REPOSITORY_PART.test(parts[0]) || parts[1] !== name) {
    invariant();
  }
  return { id, name, fullName };
};

const sameRepository = (left: GitHubRepository, right: GitHubRepository): boolean =>
  left.id === right.id && left.name === right.name && left.fullName === right.fullName;

const parseAcceptedDelivery = (value: unknown): GitHubAcceptedDelivery => {
  assertRecord(value);
  if (
    !exactKeys(value, [
      "status",
      "deliveryId",
      "installationId",
      "checkRepository",
      "checkoutRepository",
      "defaultRef",
      "event",
      "concurrency",
    ]) ||
    value.status !== "accepted"
  ) {
    invariant();
  }
  const deliveryId = parseString(value.deliveryId, UUID);
  const installationId = parseGeneration(value.installationId);
  const event = value.event;
  const concurrency = value.concurrency;
  assertRecord(event);
  assertRecord(concurrency);
  const checkRepository = parseRepository(value.checkRepository);
  const checkoutRepository = parseRepository(value.checkoutRepository);
  const defaultRef = parseString(value.defaultRef);
  if (!defaultRef.startsWith("refs/heads/")) invariant();
  if (event.type === "push") {
    if (
      !exactKeys(event, ["type", "repository", "ref", "sha"]) ||
      !exactKeys(concurrency, ["type", "repositoryId", "ref"]) ||
      concurrency.type !== "push" ||
      concurrency.repositoryId !== checkRepository.id
    ) {
      invariant();
    }
    const ref = parseString(event.ref);
    const sha = parseString(event.sha, SHA);
    if (!ref.startsWith("refs/heads/") || concurrency.ref !== ref) invariant();
    const repository = parseRepository(event.repository);
    if (
      !sameRepository(repository, checkRepository) ||
      !sameRepository(checkoutRepository, checkRepository)
    ) {
      invariant();
    }
    return {
      status: "accepted",
      deliveryId,
      installationId,
      checkRepository,
      checkoutRepository,
      defaultRef,
      event: {
        type: "push",
        repository,
        ref,
        sha,
      },
      concurrency: { type: "push", repositoryId: checkRepository.id, ref },
    };
  }
  if (
    event.type !== "pull_request" ||
    !exactKeys(event, ["type", "action", "repository", "number", "ref", "sha"]) ||
    !exactKeys(concurrency, ["type", "repositoryId", "number"]) ||
    concurrency.type !== "pull_request" ||
    concurrency.repositoryId !== checkRepository.id
  ) {
    invariant();
  }
  const action =
    event.action === "opened" || event.action === "reopened" || event.action === "synchronize"
      ? event.action
      : invariant();
  const number = parseGeneration(event.number);
  const ref = parseString(event.ref);
  const sha = parseString(event.sha, SHA);
  if (ref.length === 0 || concurrency.number !== number) invariant();
  const repository = parseRepository(event.repository);
  if (!sameRepository(repository, checkRepository)) invariant();
  return {
    status: "accepted",
    deliveryId,
    installationId,
    checkRepository,
    checkoutRepository,
    defaultRef,
    event: {
      type: "pull_request",
      action,
      repository,
      number,
      ref,
      sha,
    },
    concurrency: {
      type: "pull_request",
      repositoryId: checkRepository.id,
      number,
    },
  };
};

const concurrencyKey = (delivery: GitHubAcceptedDelivery, workflowId: string): string => {
  const scope =
    delivery.concurrency.type === "push"
      ? `push:${delivery.concurrency.repositoryId}:${delivery.concurrency.ref}`
      : `pull_request:${delivery.concurrency.repositoryId}:${delivery.concurrency.number}`;
  return `${workflowId}:${scope}`;
};

const parseCoordinatorRun = (value: unknown): GitHubCoordinatorRun => {
  assertRecord(value);
  if (!exactKeys(value, ["id", "workflow"])) invariant();
  return { id: parseString(value.id, RUN_ID), workflow: parseString(value.workflow, WORKFLOW_ID) };
};

const parseDeliveryRecord = (
  value: unknown,
  keyDeliveryId: string,
  kind: DeliveryRecord["kind"],
): DeliveryRecord => {
  assertRecord(value);
  if (
    !exactKeys(value, ["kind", "deliveryId", "expiresAt", "runs"]) ||
    value.kind !== kind ||
    value.deliveryId !== keyDeliveryId
  ) {
    invariant();
  }
  const expiresAt = parseGeneration(value.expiresAt);
  const rawRuns = Array.isArray(value.runs) ? value.runs : invariant();
  const runs = rawRuns.map(parseCoordinatorRun);
  if (new Set(runs.map(({ id }) => id)).size !== runs.length) invariant();
  return { kind, deliveryId: keyDeliveryId, expiresAt, runs };
};

const parseRun = (value: unknown, keyRunId: string): RunRecord => {
  assertRecord(value);
  const keys = [
    "kind",
    "accountId",
    "runId",
    "workflowId",
    "artifactVersion",
    "checkName",
    "delivery",
    "activeKey",
    "generation",
    "expiresAt",
    "terminal",
    "terminalPublished",
    "diagnostic",
    "desired",
    "preflightComplete",
    "checkCreateAttempted",
    "checkRunId",
    "workflowCreateAttempted",
    "workflowKnown",
    "checkInProgressComplete",
    "checkCompletionComplete",
    "terminationComplete",
    "checkCancellationComplete",
    "retryCount",
    "nextAttemptAt",
  ] as const;
  if (!exactKeys(value, keys) || value.kind !== "run") invariant();
  const accountId = parseString(value.accountId);
  const delivery = parseAcceptedDelivery(value.delivery);
  const runId = parseString(value.runId, RUN_ID);
  const match = RUN_ID.exec(runId);
  const workflowId = parseString(value.workflowId, WORKFLOW_ID);
  const artifactVersion = parseString(value.artifactVersion, /^[0-9a-f]{64}$/);
  const checkName = parseString(value.checkName);
  const activeKey = parseString(value.activeKey);
  const generation = parseGeneration(value.generation);
  const expiresAt = parseGeneration(value.expiresAt);
  const terminal = value.terminal === null ? null : terminalRecordOf(value.terminal);
  const terminalPublished = parseBoolean(value.terminalPublished);
  const diagnostic = diagnosticOf(value.diagnostic);
  const desired =
    value.desired === "queued" ||
    value.desired === "in_progress" ||
    value.desired === "success" ||
    value.desired === "failure" ||
    value.desired === "cancelled" ||
    value.desired === "skipped"
      ? value.desired
      : invariant();
  const preflightComplete = parseBoolean(value.preflightComplete);
  const checkCreateAttempted = parseBoolean(value.checkCreateAttempted);
  const checkRunId = value.checkRunId === null ? null : parseGeneration(value.checkRunId);
  const workflowCreateAttempted = parseBoolean(value.workflowCreateAttempted);
  const workflowKnown = parseBoolean(value.workflowKnown);
  const checkInProgressComplete = parseBoolean(value.checkInProgressComplete);
  const checkCompletionComplete = parseBoolean(value.checkCompletionComplete);
  const terminationComplete = parseBoolean(value.terminationComplete);
  const checkCancellationComplete = parseBoolean(value.checkCancellationComplete);
  const retryCount = parseNonnegativeInteger(value.retryCount);
  const nextAttemptAt = parseNonnegativeInteger(value.nextAttemptAt);
  const unavailableCancellation =
    desired === "cancelled" &&
    !preflightComplete &&
    !checkCreateAttempted &&
    checkRunId === null &&
    !workflowCreateAttempted &&
    !workflowKnown &&
    terminationComplete &&
    checkCancellationComplete;
  if (
    runId !== keyRunId ||
    !match ||
    Number(match[2]) !== generation ||
    activeKey !== concurrencyKey(delivery, workflowId) ||
    checkName.length === 0 ||
    (terminal !== null &&
      (terminal.accountId !== accountId ||
        terminal.repositoryId !== `github:${delivery.checkoutRepository.id}` ||
        terminal.workflowId !== workflowId ||
        terminal.runId !== runId ||
        terminal.trustId !== `github:${delivery.checkoutRepository.id}` ||
        terminal.generation !== generation)) ||
    (terminalPublished && terminal === null) ||
    (diagnostic !== null &&
      (!terminalPublished || terminal?.outcome !== "failure" || desired !== "failure")) ||
    ((desired === "success" || desired === "failure" || desired === "cancelled") &&
      (!terminalPublished || terminal?.outcome !== desired)) ||
    ((desired === "queued" || desired === "in_progress") && terminalPublished) ||
    (desired === "skipped" && terminal !== null) ||
    (checkCreateAttempted && !preflightComplete) ||
    (checkRunId !== null && !checkCreateAttempted) ||
    (workflowCreateAttempted && checkRunId === null) ||
    (workflowKnown && (!workflowCreateAttempted || checkRunId === null)) ||
    (checkInProgressComplete && (!workflowKnown || checkRunId === null)) ||
    (checkCompletionComplete && !checkInProgressComplete) ||
    (checkCompletionComplete && desired !== "success" && desired !== "failure") ||
    ((desired === "in_progress" || desired === "success" || desired === "failure") &&
      (!workflowKnown || checkRunId === null)) ||
    (terminationComplete && desired !== "cancelled") ||
    (checkCancellationComplete &&
      (desired !== "cancelled" ||
        !terminationComplete ||
        (checkRunId === null && !unavailableCancellation))) ||
    (desired === "queued" &&
      (checkInProgressComplete ||
        checkCompletionComplete ||
        terminationComplete ||
        checkCancellationComplete)) ||
    (desired === "skipped" &&
      (checkCreateAttempted ||
        checkRunId !== null ||
        workflowCreateAttempted ||
        workflowKnown ||
        checkInProgressComplete ||
        checkCompletionComplete ||
        terminationComplete ||
        checkCancellationComplete))
  ) {
    invariant();
  }
  return {
    kind: "run",
    accountId,
    runId,
    workflowId,
    artifactVersion,
    checkName,
    delivery,
    activeKey,
    generation,
    expiresAt,
    terminal,
    terminalPublished,
    diagnostic,
    desired,
    preflightComplete,
    checkCreateAttempted,
    checkRunId,
    workflowCreateAttempted,
    workflowKnown,
    checkInProgressComplete,
    checkCompletionComplete,
    terminationComplete,
    checkCancellationComplete,
    retryCount,
    nextAttemptAt,
  };
};

const parseActive = (value: unknown, keyActiveKey: string): ActiveRecord => {
  assertRecord(value);
  if (!exactKeys(value, ["kind", "activeKey", "runId", "generation"]) || value.kind !== "active") {
    invariant();
  }
  const activeKey = parseString(value.activeKey);
  const runId = parseString(value.runId, RUN_ID);
  const generation = parseGeneration(value.generation);
  const match = RUN_ID.exec(runId);
  if (activeKey !== keyActiveKey || !match || Number(match[2]) !== generation) invariant();
  return { kind: "active", activeKey, runId, generation };
};

const duePart = (value: number): string => String(value).padStart(16, "0");
const runKey = (runId: string): string => `run:${runId}`;
const deliveryKey = (deliveryId: string): string => `delivery:${deliveryId}`;
const tombstoneKey = (deliveryId: string): string => `tombstone:${deliveryId}`;
const activeStorageKey = (key: string): string => `active:${key}`;
const generationStorageKey = (key: string): string => `generation:${key}`;
const pendingKey = (dueAt: number, runId: string): string => `pending:${duePart(dueAt)}:${runId}`;
const expiryKey = (dueAt: number, deliveryId: string): string =>
  `expiry:${duePart(dueAt)}:${deliveryId}`;

const parsePending = (value: unknown, key: string): PendingRecord => {
  assertRecord(value);
  if (!exactKeys(value, ["kind", "runId", "dueAt"]) || value.kind !== "pending") invariant();
  const runId = parseString(value.runId, RUN_ID);
  const dueAt = parseNonnegativeInteger(value.dueAt);
  if (key !== pendingKey(dueAt, runId)) invariant();
  return { kind: "pending", runId, dueAt };
};

const parseExpiry = (value: unknown, key: string): ExpiryRecord => {
  assertRecord(value);
  if (!exactKeys(value, ["kind", "deliveryId", "dueAt"]) || value.kind !== "expiry") invariant();
  const deliveryId = parseString(value.deliveryId, UUID);
  const dueAt = parseGeneration(value.dueAt);
  if (key !== expiryKey(dueAt, deliveryId)) invariant();
  return { kind: "expiry", deliveryId, dueAt };
};

const sameRuns = (
  left: readonly GitHubCoordinatorRun[],
  right: readonly GitHubCoordinatorRun[],
): boolean =>
  left.length === right.length &&
  left.every(
    (run, index) => run.id === right[index]?.id && run.workflow === right[index]?.workflow,
  );

const isPending = (run: RunRecord): boolean =>
  run.desired === "queued"
    ? !run.workflowKnown
    : run.desired === "in_progress"
      ? !run.checkInProgressComplete
      : run.desired === "success" || run.desired === "failure"
        ? !run.checkCompletionComplete
        : run.desired === "cancelled"
          ? !run.checkCancellationComplete
          : false;

const isExternallyTerminal = (run: RunRecord): boolean =>
  run.desired === "skipped" || run.checkCompletionComplete || run.checkCancellationComplete;

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const dispatchSeed = async (
  repositoryId: number,
  deliveryId: string,
  workflowId: string,
): Promise<string> =>
  hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${repositoryId}\0${deliveryId}\0${workflowId}`),
    ),
  ).slice(0, 48);

const retryDelay = (retryCount: number): number =>
  Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(retryCount - 1, 20));

export class RunwayGitHubCoordinator extends DurableObject<CoordinatorEnv> {
  async admit(admission: GitHubCoordinatorAdmission): Promise<{
    readonly runs: readonly GitHubCoordinatorRun[];
  }> {
    if (!isRecord(admission) || !exactKeys(admission, ["accountId", "delivery", "workflows"])) {
      invariant();
    }
    const accountId = parseString(admission.accountId);
    const delivery = parseAcceptedDelivery(admission.delivery);
    const now = await this.#now();
    if (!Array.isArray(admission.workflows) || admission.workflows.length === 0) invariant();
    const workflows = admission.workflows.map((workflow) => {
      if (
        !isRecord(workflow) ||
        !exactKeys(workflow, ["workflowId", "artifactVersion", "checkName"]) ||
        typeof workflow.workflowId !== "string" ||
        !WORKFLOW_ID.test(workflow.workflowId) ||
        typeof workflow.artifactVersion !== "string" ||
        !/^[0-9a-f]{64}$/.test(workflow.artifactVersion) ||
        typeof workflow.checkName !== "string" ||
        workflow.checkName.length === 0
      ) {
        invariant();
      }
      return workflow;
    });
    if (new Set(workflows.map(({ workflowId }) => workflowId)).size !== workflows.length)
      invariant();
    const seeds = await Promise.all(
      workflows.map(async (workflow) => ({
        workflow,
        seed: await dispatchSeed(
          delivery.checkRepository.id,
          delivery.deliveryId,
          workflow.workflowId,
        ),
      })),
    );
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const rawTombstone = await transaction.get(tombstoneKey(delivery.deliveryId));
      if (rawTombstone !== undefined) {
        const tombstone = parseDeliveryRecord(rawTombstone, delivery.deliveryId, "tombstone");
        const detail = parseDeliveryRecord(
          await transaction.get(deliveryKey(delivery.deliveryId)),
          delivery.deliveryId,
          "delivery",
        );
        if (detail.expiresAt !== tombstone.expiresAt || !sameRuns(detail.runs, tombstone.runs)) {
          invariant();
        }
        if (tombstone.expiresAt > now) {
          for (const runRef of tombstone.runs) {
            const run = parseRun(await transaction.get(runKey(runRef.id)), runRef.id);
            if (
              run.accountId !== accountId ||
              run.workflowId !== runRef.workflow ||
              run.delivery.deliveryId !== delivery.deliveryId
            ) {
              invariant();
            }
          }
          return detail;
        }
        await transaction.delete([
          deliveryKey(delivery.deliveryId),
          tombstoneKey(delivery.deliveryId),
          expiryKey(tombstone.expiresAt, delivery.deliveryId),
        ]);
      }

      const runs: GitHubCoordinatorRun[] = [];
      for (const { workflow, seed } of seeds) {
        const activeKey = concurrencyKey(delivery, workflow.workflowId);
        const generationKey = generationStorageKey(activeKey);
        const rawGeneration = await transaction.get(generationKey);
        const currentGeneration = rawGeneration === undefined ? 0 : parseGeneration(rawGeneration);
        const generation = currentGeneration + 1;
        const runId = `runway-github-${seed}-${generation}`;
        const activeKeyName = activeStorageKey(activeKey);
        const rawPrior = await transaction.get(activeKeyName);
        if (rawPrior !== undefined) {
          const prior = parseActive(rawPrior, activeKey);
          const priorRun = parseRun(await transaction.get(runKey(prior.runId)), prior.runId);
          if (
            priorRun.accountId !== accountId ||
            priorRun.activeKey !== activeKey ||
            priorRun.generation !== prior.generation ||
            prior.generation !== currentGeneration
          ) {
            invariant();
          }
          if (
            priorRun.desired !== "cancelled" &&
            priorRun.desired !== "skipped" &&
            !priorRun.checkCompletionComplete &&
            priorRun.terminal === null
          ) {
            await transaction.delete(pendingKey(priorRun.nextAttemptAt, priorRun.runId));
            priorRun.terminal = {
              accountId: priorRun.accountId,
              repositoryId: `github:${priorRun.delivery.checkoutRepository.id}`,
              workflowId: priorRun.workflowId,
              runId: priorRun.runId,
              trustId: `github:${priorRun.delivery.checkoutRepository.id}`,
              generation: priorRun.generation,
              claimId: crypto.randomUUID(),
              outcome: "cancelled",
            };
            priorRun.terminalPublished = true;
            priorRun.diagnostic = null;
            priorRun.desired = "cancelled";
            priorRun.retryCount = 0;
            priorRun.nextAttemptAt = now;
            await transaction.put({
              [runKey(priorRun.runId)]: priorRun,
              [pendingKey(now, priorRun.runId)]: {
                kind: "pending",
                runId: priorRun.runId,
                dueAt: now,
              } satisfies PendingRecord,
            });
          }
        }
        const record: RunRecord = {
          kind: "run",
          accountId,
          runId,
          workflowId: workflow.workflowId,
          artifactVersion: workflow.artifactVersion,
          checkName: workflow.checkName,
          delivery,
          activeKey,
          generation,
          expiresAt: now + DELIVERY_RETENTION_MS,
          terminal: null,
          terminalPublished: false,
          diagnostic: null,
          desired: "queued",
          preflightComplete: false,
          checkCreateAttempted: false,
          checkRunId: null,
          workflowCreateAttempted: false,
          workflowKnown: false,
          checkInProgressComplete: false,
          checkCompletionComplete: false,
          terminationComplete: false,
          checkCancellationComplete: false,
          retryCount: 0,
          nextAttemptAt: now,
        };
        await transaction.put({
          [generationKey]: generation,
          [activeKeyName]: {
            kind: "active",
            activeKey,
            runId,
            generation,
          } satisfies ActiveRecord,
          [runKey(runId)]: record,
          [pendingKey(now, runId)]: { kind: "pending", runId, dueAt: now } satisfies PendingRecord,
        });
        runs.push({ id: runId, workflow: workflow.workflowId });
      }
      const expiresAt = now + DELIVERY_RETENTION_MS;
      const detail: DeliveryRecord = {
        kind: "delivery",
        deliveryId: delivery.deliveryId,
        expiresAt,
        runs,
      };
      const tombstone: DeliveryRecord = { ...detail, kind: "tombstone" };
      await transaction.put({
        [deliveryKey(delivery.deliveryId)]: detail,
        [tombstoneKey(delivery.deliveryId)]: tombstone,
        [expiryKey(expiresAt, delivery.deliveryId)]: {
          kind: "expiry",
          deliveryId: delivery.deliveryId,
          dueAt: expiresAt,
        } satisfies ExpiryRecord,
      });
      return detail;
    });
    await this.ctx.storage.setAlarm(Date.now());
    return { runs: result.runs };
  }

  async lifecycle(request: GitHubCoordinatorLifecycle): Promise<{ readonly proceed: boolean }> {
    if (!isRecord(request) || !exactKeys(request, ["source", "state"])) invariant();
    const source = parseGitHubRunSource(request.source);
    const state = request.state;
    if (state !== "in_progress") invariant();
    const now = await this.#now();
    const key = runKey(source.runId);
    const initial = parseRun(await this.ctx.storage.get(key), source.runId);
    await this.#validateDispatchIdentity(initial);
    this.#validateLifecycleSource(initial, source);
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const run = parseRun(await transaction.get(key), source.runId);
      this.#validateLifecycleSource(run, source);
      const generation = await transaction.get(generationStorageKey(run.activeKey));
      if (!positiveInteger(generation) || generation < run.generation) invariant();
      const rawActive = await transaction.get(activeStorageKey(run.activeKey));
      const active = rawActive === undefined ? undefined : parseActive(rawActive, run.activeKey);
      if (
        run.desired !== "cancelled" &&
        run.desired !== "skipped" &&
        !run.checkCompletionComplete &&
        run.terminal === null &&
        (generation !== run.generation ||
          active?.runId !== run.runId ||
          active.generation !== run.generation)
      ) {
        invariant();
      }
      const oldPending = pendingKey(run.nextAttemptAt, run.runId);
      const wasPending = isPending(run);
      let proceed = true;
      if (run.desired === "queued") run.desired = "in_progress";
      else if (run.desired !== "in_progress") proceed = false;
      run.workflowKnown = true;
      run.retryCount = 0;
      run.nextAttemptAt = now;
      if (wasPending) await transaction.delete(oldPending);
      await transaction.put(key, run);
      if (isPending(run)) {
        await transaction.put(pendingKey(now, run.runId), {
          kind: "pending",
          runId: run.runId,
          dueAt: now,
        } satisfies PendingRecord);
      }
      return { proceed };
    });
    await this.ctx.storage.setAlarm(Date.now());
    return result;
  }

  async claimTerminal(request: {
    readonly source: GitHubRunSource;
    readonly candidate: TerminalRecord;
  }): Promise<TerminalRecord> {
    if (!isRecord(request) || !exactKeys(request, ["source", "candidate"])) invariant();
    const source = parseGitHubRunSource(request.source);
    const candidate = terminalRecordOf(request.candidate);
    const key = runKey(source.runId);
    const initial = parseRun(await this.ctx.storage.get(key), source.runId);
    await this.#validateDispatchIdentity(initial);
    this.#validateLifecycleSource(initial, source);
    const winner = await this.ctx.storage.transaction(async (transaction) => {
      const run = parseRun(await transaction.get(key), source.runId);
      this.#validateLifecycleSource(run, source);
      this.#validateTerminalRecord(run, candidate);
      if (run.terminal !== null) return run.terminal;
      if (run.desired === "cancelled" || run.desired === "skipped") invariant();
      run.terminal = candidate;
      await transaction.put(key, run);
      return candidate;
    });
    return winner;
  }

  async readTerminal(sourceValue: GitHubRunSource): Promise<TerminalRecord | undefined> {
    const source = parseGitHubRunSource(sourceValue);
    const run = parseRun(await this.ctx.storage.get(runKey(source.runId)), source.runId);
    await this.#validateDispatchIdentity(run);
    this.#validateLifecycleSource(run, source);
    return run.terminal ?? undefined;
  }

  async current(sourceValue: GitHubRunSource): Promise<boolean> {
    const source = parseGitHubRunSource(sourceValue);
    const run = parseRun(await this.ctx.storage.get(runKey(source.runId)), source.runId);
    await this.#validateDispatchIdentity(run);
    this.#validateLifecycleSource(run, source);
    const generation = await this.ctx.storage.get(generationStorageKey(run.activeKey));
    if (!positiveInteger(generation) || generation < run.generation) invariant();
    const rawActive = await this.ctx.storage.get(activeStorageKey(run.activeKey));
    const active = rawActive === undefined ? undefined : parseActive(rawActive, run.activeKey);
    return (
      generation === run.generation &&
      active?.runId === run.runId &&
      active.generation === run.generation
    );
  }

  async publishTerminal(request: {
    readonly source: GitHubRunSource;
    readonly finalization: Finalization;
    readonly diagnostic: FailureDiagnostic | null;
  }): Promise<void> {
    if (!isRecord(request) || !exactKeys(request, ["source", "finalization", "diagnostic"])) {
      invariant();
    }
    const source = parseGitHubRunSource(request.source);
    const finalization = finalizationOf(request.finalization);
    const diagnostic = diagnosticOf(request.diagnostic);
    if (finalization.outcome !== "failure" && diagnostic !== null) invariant();
    const now = await this.#now();
    const key = runKey(source.runId);
    const initial = parseRun(await this.ctx.storage.get(key), source.runId);
    await this.#validateDispatchIdentity(initial);
    this.#validateLifecycleSource(initial, source);
    await this.ctx.storage.transaction(async (transaction) => {
      const run = parseRun(await transaction.get(key), source.runId);
      this.#validateLifecycleSource(run, source);
      if (
        run.terminal === null ||
        run.terminal.claimId !== finalization.claimId ||
        run.terminal.outcome !== finalization.outcome
      ) {
        invariant();
      }
      if (run.terminalPublished) {
        if (!sameFailureDiagnostic(run.diagnostic, diagnostic)) invariant();
        return;
      }
      const oldPending = pendingKey(run.nextAttemptAt, run.runId);
      const wasPending = isPending(run);
      run.terminalPublished = true;
      run.diagnostic = diagnostic;
      run.desired = finalization.outcome;
      run.retryCount = 0;
      run.nextAttemptAt = now;
      if (wasPending) await transaction.delete(oldPending);
      await transaction.put(key, run);
      if (isPending(run)) {
        await transaction.put(pendingKey(now, run.runId), {
          kind: "pending",
          runId: run.runId,
          dueAt: now,
        } satisfies PendingRecord);
      }
    });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const now = await this.#now();
    let budget = ALARM_BATCH_SIZE;
    const dueEnd = `${duePart(now)}:\uffff`;
    const expiries = await this.ctx.storage.list({
      prefix: "expiry:",
      end: `expiry:${dueEnd}`,
      limit: budget,
    });
    for (const [key, raw] of expiries) {
      await this.#expire(parseExpiry(raw, key), key, now);
      budget -= 1;
    }
    if (budget > 0) {
      const pending = await this.ctx.storage.list({
        prefix: "pending:",
        end: `pending:${dueEnd}`,
        limit: budget,
      });
      for (const [key, raw] of pending) {
        const entry = parsePending(raw, key);
        const run = await this.#validatedRunForEffect(entry);
        try {
          await this.#advance(runKey(run.runId), run, now);
        } catch (error) {
          if (error instanceof DurableInvariantError) throw error;
          await this.#scheduleRetry(run.runId, now);
        }
      }
    }
    await this.#scheduleNextAlarm(now);
  }

  async #now(): Promise<number> {
    const value = this.env.RUNWAY_GITHUB_CLOCK
      ? await this.env.RUNWAY_GITHUB_CLOCK.now()
      : Date.now();
    if (!nonnegativeInteger(value)) invariant();
    return value;
  }

  async #expire(entry: ExpiryRecord, key: string, now: number): Promise<void> {
    if (entry.dueAt > now) invariant();
    const detail = parseDeliveryRecord(
      await this.ctx.storage.get(deliveryKey(entry.deliveryId)),
      entry.deliveryId,
      "delivery",
    );
    const tombstone = parseDeliveryRecord(
      await this.ctx.storage.get(tombstoneKey(entry.deliveryId)),
      entry.deliveryId,
      "tombstone",
    );
    if (
      detail.expiresAt !== entry.dueAt ||
      tombstone.expiresAt !== entry.dueAt ||
      !sameRuns(detail.runs, tombstone.runs)
    ) {
      invariant();
    }
    const deleteKeys = [key, deliveryKey(entry.deliveryId), tombstoneKey(entry.deliveryId)];
    for (const ref of detail.runs) {
      const rawRun = await this.ctx.storage.get(runKey(ref.id));
      if (rawRun === undefined) continue;
      const run = parseRun(rawRun, ref.id);
      if (run.workflowId !== ref.workflow || run.delivery.deliveryId !== entry.deliveryId)
        invariant();
      await this.#validateDispatchIdentity(run);
      if (run.expiresAt <= now && isExternallyTerminal(run)) {
        const rawActive = await this.ctx.storage.get(activeStorageKey(run.activeKey));
        const active = rawActive === undefined ? undefined : parseActive(rawActive, run.activeKey);
        if (active?.runId !== run.runId) {
          deleteKeys.push(runKey(run.runId), pendingKey(run.nextAttemptAt, run.runId));
        }
      }
    }
    await this.ctx.storage.transaction(async (transaction) => {
      const currentExpiry = parseExpiry(await transaction.get(key), key);
      if (currentExpiry.deliveryId !== entry.deliveryId || currentExpiry.dueAt !== entry.dueAt) {
        invariant();
      }
      await transaction.delete(deleteKeys);
    });
  }

  async #validateDispatchIdentity(run: RunRecord): Promise<void> {
    const expectedSeed = await dispatchSeed(
      run.delivery.checkRepository.id,
      run.delivery.deliveryId,
      run.workflowId,
    );
    const runMatch = RUN_ID.exec(run.runId);
    if (!runMatch || runMatch[1] !== expectedSeed) invariant();
  }

  #validateLifecycleSource(run: RunRecord, source: GitHubRunSource): void {
    if (
      source.runId !== run.runId ||
      source.generation !== run.generation ||
      source.admission.type !== run.delivery.event.type ||
      source.admission.defaultRef !== run.delivery.defaultRef ||
      (source.admission.type === "push" &&
        (run.delivery.event.type !== "push" || source.admission.ref !== run.delivery.event.ref)) ||
      (source.admission.type === "pull_request" &&
        (run.delivery.event.type !== "pull_request" ||
          source.admission.number !== run.delivery.event.number)) ||
      source.deliveryId !== run.delivery.deliveryId ||
      source.installationId !== run.delivery.installationId ||
      source.commit !== run.delivery.event.sha ||
      !sameRepository(source.repository, run.delivery.checkoutRepository) ||
      source.check.id !== run.checkRunId ||
      source.check.name !== run.checkName ||
      !sameRepository(source.check.repository, run.delivery.checkRepository) ||
      !run.workflowCreateAttempted
    ) {
      invariant();
    }
  }

  #validateTerminalRecord(run: RunRecord, record: TerminalRecord): void {
    if (
      record.accountId !== run.accountId ||
      record.repositoryId !== `github:${run.delivery.checkoutRepository.id}` ||
      record.workflowId !== run.workflowId ||
      record.runId !== run.runId ||
      record.trustId !== `github:${run.delivery.checkoutRepository.id}` ||
      record.generation !== run.generation
    ) {
      invariant();
    }
  }

  async #validatedRunForEffect(entry: PendingRecord): Promise<RunRecord> {
    const run = parseRun(await this.ctx.storage.get(runKey(entry.runId)), entry.runId);
    if (run.nextAttemptAt !== entry.dueAt || !isPending(run)) invariant();
    await this.#validateDispatchIdentity(run);
    const generation = await this.ctx.storage.get(generationStorageKey(run.activeKey));
    if (!positiveInteger(generation) || generation < run.generation) invariant();
    const rawActive = await this.ctx.storage.get(activeStorageKey(run.activeKey));
    const active = rawActive === undefined ? undefined : parseActive(rawActive, run.activeKey);
    if (run.desired !== "cancelled" && run.desired !== "skipped" && run.terminal === null) {
      if (
        generation !== run.generation ||
        active?.runId !== run.runId ||
        active.generation !== run.generation
      ) {
        invariant();
      }
    } else if (active?.runId === run.runId && active.generation !== run.generation) {
      invariant();
    }
    return run;
  }

  async #scheduleNextAlarm(now: number): Promise<void> {
    const [pending, expiry] = await Promise.all([
      this.ctx.storage.list({ prefix: "pending:", limit: 1 }),
      this.ctx.storage.list({ prefix: "expiry:", limit: 1 }),
    ]);
    let next: number | undefined;
    for (const [key, raw] of pending) next = parsePending(raw, key).dueAt;
    for (const [key, raw] of expiry) {
      const dueAt = parseExpiry(raw, key).dueAt;
      if (next === undefined || dueAt < next) next = dueAt;
    }
    if (next === undefined) await this.ctx.storage.deleteAlarm();
    else {
      await this.ctx.storage.setAlarm(Date.now() + (next <= now ? PROGRESS_DELAY_MS : next - now));
    }
  }

  async #getRun(key: string, fallback?: RunRecord): Promise<RunRecord> {
    const raw = await this.ctx.storage.get(key);
    if (raw === undefined) {
      if (fallback) return fallback;
      invariant();
    }
    return parseRun(raw, key.slice("run:".length));
  }

  async #saveProgress(run: RunRecord, now: number): Promise<void> {
    const oldPending = pendingKey(run.nextAttemptAt, run.runId);
    run.retryCount = 0;
    run.nextAttemptAt = now;
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.delete(oldPending);
      await transaction.put(runKey(run.runId), run);
      if (isPending(run)) {
        await transaction.put(pendingKey(now, run.runId), {
          kind: "pending",
          runId: run.runId,
          dueAt: now,
        } satisfies PendingRecord);
      }
    });
  }

  async #saveIntent(run: RunRecord): Promise<void> {
    await this.ctx.storage.put(runKey(run.runId), run);
  }

  async #saveTerminalProgress(run: RunRecord, now: number): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const current = parseRun(await transaction.get(runKey(run.runId)), run.runId);
      if (current.desired !== run.desired) return;
      if (current.desired !== "success" && current.desired !== "failure") invariant();
      const oldPending = pendingKey(current.nextAttemptAt, current.runId);
      current.checkCompletionComplete = true;
      current.retryCount = 0;
      current.nextAttemptAt = now;
      const rawActive = await transaction.get(activeStorageKey(current.activeKey));
      const active =
        rawActive === undefined ? undefined : parseActive(rawActive, current.activeKey);
      if (
        active !== undefined &&
        active.runId === current.runId &&
        active.generation !== current.generation
      ) {
        invariant();
      }
      await transaction.delete(oldPending);
      await transaction.put(runKey(current.runId), current);
      if (active?.runId === current.runId && active.generation === current.generation) {
        await transaction.delete(activeStorageKey(current.activeKey));
      }
    });
  }

  async #scheduleRetry(runId: string, now: number): Promise<void> {
    const run = await this.#getRun(runKey(runId));
    const oldPending = pendingKey(run.nextAttemptAt, run.runId);
    if (!isPending(run)) {
      await this.ctx.storage.delete(oldPending);
      return;
    }
    run.retryCount += 1;
    run.nextAttemptAt = now + retryDelay(run.retryCount);
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.delete(oldPending);
      await transaction.put({
        [runKey(run.runId)]: run,
        [pendingKey(run.nextAttemptAt, run.runId)]: {
          kind: "pending",
          runId: run.runId,
          dueAt: run.nextAttemptAt,
        } satisfies PendingRecord,
      });
    });
  }

  #provider(): CoordinatorProvider {
    if (this.env.RUNWAY_GITHUB_PROVIDER) return this.env.RUNWAY_GITHUB_PROVIDER;
    const appId = this.env.RUNWAY_GITHUB_APP_ID;
    const privateKey = this.env.RUNWAY_GITHUB_PRIVATE_KEY;
    if (typeof appId !== "string" || typeof privateKey !== "string") {
      throw new Error("missing GitHub App credentials");
    }
    return createGitHubProvider({ appId, privateKey });
  }

  #workflow(): WorkflowEffects {
    if (this.env.RUNWAY_GITHUB_WORKFLOW) return this.env.RUNWAY_GITHUB_WORKFLOW;
    const binding = this.env.WORKFLOWS;
    if (!binding) throw new Error("missing Dynamic Workflow binding");
    return {
      create: async (options) => await binding.create(options),
      status: async (id) => await (await binding.get(id)).status(),
      terminate: async (id) => await (await binding.get(id)).terminate(),
    };
  }

  async #clearActiveIfCurrent(run: RunRecord): Promise<void> {
    const key = activeStorageKey(run.activeKey);
    await this.ctx.storage.transaction(async (transaction) => {
      const rawActive = await transaction.get(key);
      if (rawActive === undefined) return;
      const active = parseActive(rawActive, run.activeKey);
      if (active.runId === run.runId && active.generation === run.generation) {
        await transaction.delete(key);
      }
    });
  }

  async #token(run: RunRecord, purpose: "checkout" | "checks") {
    const repository =
      purpose === "checkout" ? run.delivery.checkoutRepository : run.delivery.checkRepository;
    return await this.#provider().createInstallationToken({
      installationId: run.delivery.installationId,
      repository,
      purpose,
    });
  }

  async #advance(key: string, stale: RunRecord, now: number): Promise<void> {
    let run = await this.#getRun(key, stale);
    if (!run.preflightComplete) {
      try {
        await this.#token(run, "checkout");
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          "name" in error &&
          (error.name === "GitHubRepositoryUnavailableError" ||
            ("message" in error &&
              error.message === "GitHub repository is unavailable to the installation"))
        ) {
          run = await this.#getRun(key, run);
          if (run.desired === "cancelled") {
            run.terminationComplete = true;
            run.checkCancellationComplete = true;
            await this.#saveProgress(run, now);
            return;
          }
          run.desired = "skipped";
          await this.#clearActiveIfCurrent(run);
          await this.#saveProgress(run, now);
          return;
        }
        throw error;
      }
      run = await this.#getRun(key, run);
      run.preflightComplete = true;
      await this.#saveProgress(run, now);
      return;
    }

    if (run.checkRunId === null) {
      const token = (await this.#token(run, "checks")).token;
      run = await this.#getRun(key, run);
      if (run.checkCreateAttempted) {
        const check = await this.#provider().reconcileCheck({
          token,
          repository: run.delivery.checkRepository,
          name: run.checkName,
          headSha: run.delivery.event.sha,
          runId: run.runId,
        });
        run = await this.#getRun(key, run);
        if (check) run.checkRunId = check.id;
        else run.checkCreateAttempted = false;
        await this.#saveProgress(run, now);
        return;
      }
      run.checkCreateAttempted = true;
      await this.#saveIntent(run);
      const check = await this.#provider().createQueuedCheck({
        token,
        repository: run.delivery.checkRepository,
        name: run.checkName,
        headSha: run.delivery.event.sha,
        runId: run.runId,
      });
      run = await this.#getRun(key, run);
      run.checkRunId = check.id;
      await this.#saveProgress(run, now);
      return;
    }

    if (run.desired === "cancelled") {
      if (!run.terminationComplete) {
        if (!run.workflowCreateAttempted) {
          run.terminationComplete = true;
          await this.#saveProgress(run, now);
          return;
        }
        const status = parseWorkflowStatus(await this.#workflow().status(run.runId));
        run = await this.#getRun(key, run);
        if (run.desired !== "cancelled") return;
        if (status === "unknown" || workflowIsTerminal(status)) {
          if (status !== "unknown") run.workflowKnown = true;
          run.terminationComplete = true;
          await this.#saveProgress(run, now);
          return;
        }
        if (!run.workflowKnown) {
          run.workflowKnown = true;
          await this.#saveProgress(run, now);
          return;
        }
        await this.#workflow().terminate(run.runId);
        run = await this.#getRun(key, run);
        if (run.desired === "cancelled") {
          run.terminationComplete = true;
          await this.#saveProgress(run, now);
        }
        return;
      }
      const token = (await this.#token(run, "checks")).token;
      run = await this.#getRun(key, run);
      if (run.desired !== "cancelled" || run.checkRunId === null) return;
      await this.#provider().completeCheck({
        token,
        repository: run.delivery.checkRepository,
        checkRunId: run.checkRunId,
        conclusion: "cancelled",
      });
      run = await this.#getRun(key, run);
      run.checkCancellationComplete = true;
      await this.#saveProgress(run, now);
      return;
    }

    if (run.desired === "skipped") return;
    if (run.desired === "in_progress" || run.desired === "success" || run.desired === "failure") {
      if (!run.checkInProgressComplete) {
        const token = (await this.#token(run, "checks")).token;
        run = await this.#getRun(key, run);
        if (run.desired === "cancelled") return;
        const checkRunId = run.checkRunId ?? invariant();
        await this.#provider().markCheckInProgress({
          token,
          repository: run.delivery.checkRepository,
          checkRunId,
        });
        run = await this.#getRun(key, run);
        run.checkInProgressComplete = true;
        await this.#saveProgress(run, now);
        return;
      }
      if (run.desired === "in_progress") return;
      const desired = run.desired;
      const token = (await this.#token(run, "checks")).token;
      run = await this.#getRun(key, run);
      if (run.desired !== desired || run.checkRunId === null) return;
      const output = desired === "failure" ? checkOutput(run.diagnostic) : undefined;
      await this.#provider().completeCheck({
        token,
        repository: run.delivery.checkRepository,
        checkRunId: run.checkRunId,
        conclusion: desired,
        ...(output ? { output } : {}),
      });
      run = await this.#getRun(key, run);
      if (run.desired !== desired) return;
      await this.#saveTerminalProgress(run, now);
      return;
    }
    if (run.workflowCreateAttempted && !run.workflowKnown) {
      const status = parseWorkflowStatus(await this.#workflow().status(run.runId));
      run = await this.#getRun(key, run);
      if (status !== "unknown") run.workflowKnown = true;
      else run.workflowCreateAttempted = false;
      await this.#saveProgress(run, now);
      return;
    }
    if (!run.workflowCreateAttempted) {
      run.workflowCreateAttempted = true;
      await this.#saveIntent(run);
      const source: GitHubRunSource = {
        type: "github",
        installationId: run.delivery.installationId,
        repository: run.delivery.checkoutRepository,
        commit: run.delivery.event.sha,
        deliveryId: run.delivery.deliveryId,
        runId: run.runId,
        generation: run.generation,
        admission:
          run.delivery.event.type === "push"
            ? {
                type: "push",
                ref: run.delivery.event.ref,
                defaultRef: run.delivery.defaultRef,
              }
            : {
                type: "pull_request",
                number: run.delivery.event.number,
                defaultRef: run.delivery.defaultRef,
              },
        check: {
          id: run.checkRunId,
          name: run.checkName,
          repository: run.delivery.checkRepository,
        },
      };
      const created = await this.#workflow().create({
        id: run.runId,
        params: {
          __dispatcherMetadata: { artifactVersion: run.artifactVersion, source },
          params: run.delivery.event,
        },
      });
      if ((await workflowInstanceId(created)) !== run.runId) {
        throw new Error("invalid Workflow create response");
      }
      run = await this.#getRun(key, run);
      run.workflowKnown = true;
      await this.#saveProgress(run, now);
    }
  }
}
