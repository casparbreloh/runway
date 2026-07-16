import type { StandardSchemaV1 } from "@standard-schema/spec";
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { cron, ExecError, github, webhook, workflow } from "runway";
import type { ExecOptions, ExecResult } from "runway";
import { toEntrypoint } from "runway/runtime";

import { createRouter } from "../src/router.ts";
import type { PreparedSource, SourceIdentity } from "../src/source.ts";
import type { Finalization, TerminalIdentity, TerminalRecord } from "../src/terminal.ts";
import { repositoryFixture } from "./repository-fixture.ts";

let githubEffectEvents: string[] = [];

const githubProviderState = {
  tokenStarts: [] as Array<{ purpose: string; repositoryId: number }>,
  tokens: [] as Array<{ purpose: string; repositoryId: number }>,
  checks: [] as Array<{
    id: number;
    name: string;
    headSha: string;
    externalId: string;
    status: "queued" | "in_progress" | "completed";
    conclusion: string | null;
  }>,
  completions: [] as Array<{ checkRunId: number; conclusion: string }>,
  reconciliations: [] as Array<{ name: string; headSha: string; runId: string }>,
  updates: [] as Array<{ checkRunId: number; state: string }>,
  unavailableRepositoryId: undefined as number | undefined,
  loseCheckCreateResponse: false,
  losePatchResponse: false,
  failTokenAttempts: 0,
  failTokenRepositoryId: undefined as number | undefined,
  tokenDelayMs: 0,
  checkTokenDelayMs: 0,
};

export class GitHubProviderProbe extends WorkerEntrypoint<Cloudflare.Env> {
  async createInstallationToken(options: {
    purpose: string;
    repository: { id: number };
  }): Promise<{ token: string; expiresAt: string }> {
    githubProviderState.tokenStarts.push({
      purpose: options.purpose,
      repositoryId: options.repository.id,
    });
    if (
      githubProviderState.failTokenAttempts > 0 &&
      (githubProviderState.failTokenRepositoryId === undefined ||
        githubProviderState.failTokenRepositoryId === options.repository.id)
    ) {
      githubProviderState.failTokenAttempts -= 1;
      throw new Error("transient GitHub provider outage");
    }
    const delay =
      options.purpose === "checks" && githubProviderState.checkTokenDelayMs > 0
        ? githubProviderState.checkTokenDelayMs
        : githubProviderState.tokenDelayMs;
    if (delay > 0) {
      await scheduler.wait(delay);
    }
    githubProviderState.tokens.push({
      purpose: options.purpose,
      repositoryId: options.repository.id,
    });
    if (githubProviderState.unavailableRepositoryId === options.repository.id) {
      const error = new Error("GitHub repository is unavailable to the installation");
      error.name = "GitHubRepositoryUnavailableError";
      throw error;
    }
    return { token: "test-token", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }

  async createQueuedCheck(options: {
    name: string;
    headSha: string;
    runId: string;
  }): Promise<(typeof githubProviderState.checks)[number]> {
    const check = {
      id: githubProviderState.checks.length + 501,
      name: options.name,
      headSha: options.headSha,
      externalId: options.runId,
      status: "queued" as const,
      conclusion: null,
    };
    githubProviderState.checks.push(check);
    if (githubProviderState.loseCheckCreateResponse) {
      githubProviderState.loseCheckCreateResponse = false;
      throw new Error("lost Check create response");
    }
    return check;
  }

  async reconcileCheck(options: {
    name: string;
    headSha: string;
    runId: string;
  }): Promise<(typeof githubProviderState.checks)[number] | undefined> {
    githubProviderState.reconciliations.push(options);
    return githubProviderState.checks.find(
      (check) =>
        check.name === options.name &&
        check.headSha === options.headSha &&
        check.externalId === options.runId,
    );
  }

  async completeCheck(options: {
    checkRunId: number;
    conclusion: string;
  }): Promise<(typeof githubProviderState.checks)[number]> {
    const check = githubProviderState.checks.find(({ id }) => id === options.checkRunId);
    if (!check) throw new Error("missing Check");
    check.status = "completed";
    check.conclusion = options.conclusion;
    githubProviderState.completions.push({
      checkRunId: options.checkRunId,
      conclusion: options.conclusion,
    });
    githubProviderState.updates.push({ checkRunId: options.checkRunId, state: options.conclusion });
    githubEffectEvents.push(`check:${options.checkRunId}:${options.conclusion}`);
    if (githubProviderState.losePatchResponse) {
      githubProviderState.losePatchResponse = false;
      throw new Error("lost Check PATCH response");
    }
    return check;
  }

  async markCheckInProgress(options: {
    checkRunId: number;
  }): Promise<(typeof githubProviderState.checks)[number]> {
    const check = githubProviderState.checks.find(({ id }) => id === options.checkRunId);
    if (!check) throw new Error("missing Check");
    check.status = "in_progress";
    check.conclusion = null;
    githubProviderState.updates.push({ checkRunId: options.checkRunId, state: "in_progress" });
    githubEffectEvents.push(`check:${options.checkRunId}:in_progress`);
    if (githubProviderState.losePatchResponse) {
      githubProviderState.losePatchResponse = false;
      throw new Error("lost Check PATCH response");
    }
    return check;
  }

  reset(): void {
    githubProviderState.tokens = [];
    githubProviderState.tokenStarts = [];
    githubProviderState.checks = [];
    githubProviderState.completions = [];
    githubProviderState.reconciliations = [];
    githubProviderState.updates = [];
    githubProviderState.unavailableRepositoryId = undefined;
    githubProviderState.loseCheckCreateResponse = false;
    githubProviderState.losePatchResponse = false;
    githubProviderState.failTokenAttempts = 0;
    githubProviderState.failTokenRepositoryId = undefined;
    githubProviderState.tokenDelayMs = 0;
    githubProviderState.checkTokenDelayMs = 0;
    githubEffectEvents = [];
  }

  configure(options: {
    unavailableRepositoryId?: number;
    loseCheckCreateResponse?: boolean;
    losePatchResponse?: boolean;
    failTokenAttempts?: number;
    failTokenRepositoryId?: number;
    tokenDelayMs?: number;
    checkTokenDelayMs?: number;
  }): void {
    githubProviderState.unavailableRepositoryId = options.unavailableRepositoryId;
    githubProviderState.loseCheckCreateResponse = options.loseCheckCreateResponse ?? false;
    githubProviderState.losePatchResponse = options.losePatchResponse ?? false;
    githubProviderState.failTokenAttempts = options.failTokenAttempts ?? 0;
    githubProviderState.failTokenRepositoryId = options.failTokenRepositoryId;
    githubProviderState.tokenDelayMs = options.tokenDelayMs ?? 0;
    githubProviderState.checkTokenDelayMs = options.checkTokenDelayMs ?? 0;
  }

  state(): typeof githubProviderState & { effectEvents: string[] } {
    return { ...githubProviderState, effectEvents: githubEffectEvents };
  }
}

let githubClockOffset = 0;

export class GitHubClockProbe extends WorkerEntrypoint<Cloudflare.Env> {
  now(): number {
    return Date.now() + githubClockOffset;
  }

  reset(): void {
    githubClockOffset = 0;
  }

  advance(milliseconds: number): void {
    githubClockOffset += milliseconds;
  }
}

const githubWorkflowState = {
  runs: new Map<string, unknown>(),
  creates: [] as Array<{ id: string; params: unknown }>,
  terminations: [] as string[],
  loseCreateResponse: false,
  instanceCreateResponse: false,
  statusResponse: undefined as Record<string, unknown> | undefined,
  failTerminateAttempts: 0,
  terminationAttempts: [] as string[],
};

class GitHubWorkflowInstanceProbe extends RpcTarget {
  #id: string;

  constructor(id: string) {
    super();
    this.#id = id;
  }

  get id(): string {
    return this.#id;
  }

  status(): { status: "running"; output: null; platformTrace: string } {
    return { status: "running", output: null, platformTrace: "instance-probe" };
  }

  async pause(): Promise<void> {}

  async resume(): Promise<void> {}

  async terminate(): Promise<void> {}

  async restart(): Promise<void> {}

  async sendEvent(): Promise<void> {}
}

export class GitHubWorkflowProbe extends WorkerEntrypoint<Cloudflare.Env> {
  async create(options: {
    id: string;
    params: unknown;
  }): Promise<{ id: string } | GitHubWorkflowInstanceProbe> {
    if (!githubWorkflowState.runs.has(options.id)) {
      githubWorkflowState.runs.set(options.id, options.params);
      githubWorkflowState.creates.push(options);
    }
    if (githubWorkflowState.loseCreateResponse) {
      githubWorkflowState.loseCreateResponse = false;
      throw new Error("lost Workflow create response");
    }
    return githubWorkflowState.instanceCreateResponse
      ? new GitHubWorkflowInstanceProbe(options.id)
      : { id: options.id };
  }

  status(id: string): Record<string, unknown> {
    if (!githubWorkflowState.runs.has(id)) return { status: "unknown" };
    return githubWorkflowState.statusResponse ?? { status: "running" };
  }

  terminate(id: string): void {
    githubWorkflowState.terminationAttempts.push(id);
    githubEffectEvents.push(`terminate:${id}:attempt`);
    if (githubWorkflowState.failTerminateAttempts > 0) {
      githubWorkflowState.failTerminateAttempts -= 1;
      githubEffectEvents.push(`terminate:${id}:failure`);
      throw new Error("transient Workflow terminate failure");
    }
    if (
      githubWorkflowState.statusResponse?.status === "errored" ||
      githubWorkflowState.statusResponse?.status === "terminated" ||
      githubWorkflowState.statusResponse?.status === "complete"
    ) {
      throw new Error("cannot terminate a terminal Workflow instance");
    }
    if (githubWorkflowState.runs.has(id) && !githubWorkflowState.terminations.includes(id)) {
      githubWorkflowState.terminations.push(id);
      githubEffectEvents.push(`terminate:${id}:success`);
    }
  }

  reset(): void {
    githubWorkflowState.runs.clear();
    githubWorkflowState.creates = [];
    githubWorkflowState.terminations = [];
    githubWorkflowState.loseCreateResponse = false;
    githubWorkflowState.instanceCreateResponse = false;
    githubWorkflowState.statusResponse = undefined;
    githubWorkflowState.failTerminateAttempts = 0;
    githubWorkflowState.terminationAttempts = [];
  }

  configure(options: {
    loseCreateResponse?: boolean;
    instanceCreateResponse?: boolean;
    statusResponse?: Record<string, unknown>;
    failTerminateAttempts?: number;
  }): void {
    githubWorkflowState.loseCreateResponse = options.loseCreateResponse ?? false;
    githubWorkflowState.instanceCreateResponse = options.instanceCreateResponse ?? false;
    githubWorkflowState.statusResponse = options.statusResponse;
    githubWorkflowState.failTerminateAttempts = options.failTerminateAttempts ?? 0;
  }

  state(): {
    runs: Array<[string, unknown]>;
    creates: typeof githubWorkflowState.creates;
    terminations: string[];
    terminationAttempts: string[];
  } {
    return {
      runs: [...githubWorkflowState.runs],
      creates: githubWorkflowState.creates,
      terminations: githubWorkflowState.terminations,
      terminationAttempts: githubWorkflowState.terminationAttempts,
    };
  }
}

interface NormalizedExecOptions {
  command: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}

interface SandboxRequest {
  runId: string;
  step: { id: string; count: number; attempt: number };
  options: NormalizedExecOptions;
  secrets: ReadonlyArray<string>;
  source: PreparedSource;
}

const sandboxState = {
  executions: [] as Array<{
    runId: string;
    step: { id: string; count: number; attempt: number };
    options: NormalizedExecOptions;
    secrets: ReadonlyArray<string>;
  }>,
  destroys: [] as string[],
  kills: [] as string[],
};
let runtimeLifecycleEvents: string[] = [];
const activeExecutions = new Map<string, () => void>();
const workspaces = new Map<string, string>();
let sourcePreparations: unknown[] = [];
const secretSnapshots = new Map<string, Readonly<Record<string, string>>>();
let destroyAttempts = 0;
let failNextDestroy = false;
let currentHostSecret = "sandbox-secret";
let lastHostDestroySecrets: ReadonlyArray<string> = [];
let failSecretCapture = false;
let failNextSecretRestore = false;
let failNextSecretValidation = false;

export class TestSandbox extends WorkerEntrypoint<Cloudflare.Env> {
  source(): SourceIdentity {
    return {
      repositoryId: `remote:${repositoryFixture.remote}`,
      remote: repositoryFixture.remote,
      revision: repositoryFixture.commit,
    };
  }

  prepareSource(request: {
    runId: string;
    source: SourceIdentity;
    secrets: Readonly<Record<string, string>>;
    allowReconstruct: boolean;
  }): PreparedSource {
    sourcePreparations.push(structuredClone(request));
    const expected = this.source();
    if (JSON.stringify(request.source) !== JSON.stringify(expected)) {
      throw new Error("unexpected source");
    }
    return {
      placement: `placement:${request.runId}`,
      result: { revision: expected.revision, state: "prepared", bytes: 0 },
    };
  }

  async exec(request: SandboxRequest): Promise<ExecResult> {
    const { runId, step, options, secrets } = request;
    sandboxState.executions.push({ runId, step, options, secrets });
    if (options.command === "ambiguous-start") {
      const error = new Error("run continuity was lost: ambiguous command start");
      error.name = "RunLostError";
      throw error;
    }
    if (options.command === "confirmed-timeout") {
      const error = new Error("command timed out after 25ms");
      error.name = "ExecTimeoutError";
      throw error;
    }
    if (options.command === "block") {
      const blocked = new Promise<void>((resolve) => activeExecutions.set(runId, resolve));
      this.ctx.waitUntil(
        (async () => {
          while (activeExecutions.has(runId)) {
            await scheduler.wait(10);
            if ((await (await this.env.COMMANDS.get(runId)).status()).status === "terminated") {
              await this.destroy(runId, secrets);
              return;
            }
          }
        })(),
      );
      await blocked;
    }
    if (options.command === "exit 7") {
      return { exitCode: 7, stdout: "tail", stderr: "failed", durationMs: 4 };
    }
    if (options.command.includes("sandbox-secret")) {
      return {
        exitCode: 9,
        stdout: "stdout sandbox-secret",
        stderr: "stderr sandbox-secret",
        durationMs: 4,
      };
    }
    if (options.command === "echo hello > state.txt") {
      workspaces.set(runId, "hello\n");
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 2 };
    }
    if (options.command === "cat state.txt") {
      const state = workspaces.get(runId);
      return state === undefined
        ? {
            exitCode: 1,
            stdout: "",
            stderr: "cat: state.txt: No such file\n",
            durationMs: 2,
          }
        : { exitCode: 0, stdout: state, stderr: "", durationMs: 2 };
    }
    return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 8 };
  }

  async destroy(runId: string, _secrets: ReadonlyArray<string>): Promise<void> {
    runtimeLifecycleEvents.push("cleanup:start");
    destroyAttempts += 1;
    if (failNextDestroy) {
      failNextDestroy = false;
      runtimeLifecycleEvents.push("cleanup:failure");
      throw new Error("transient destroy failure");
    }
    const unblock = activeExecutions.get(runId);
    if (unblock) {
      sandboxState.kills.push(runId);
      activeExecutions.delete(runId);
      unblock();
    }
    sandboxState.destroys.push(runId);
    workspaces.delete(runId);
    runtimeLifecycleEvents.push("cleanup:success");
  }

  state(): typeof sandboxState {
    return sandboxState;
  }

  reset(): void {
    sandboxState.executions = [];
    sandboxState.destroys = [];
    sandboxState.kills = [];
    activeExecutions.clear();
    workspaces.clear();
    sourcePreparations = [];
    destroyAttempts = 0;
    failNextDestroy = false;
    runtimeLifecycleEvents = [];
  }

  sourceState(): unknown[] {
    return sourcePreparations;
  }

  failDestroyOnce(): void {
    failNextDestroy = true;
  }

  destroyAttempts(): number {
    return destroyAttempts;
  }
}

interface TestHostProps {
  readonly secrets: Readonly<Record<string, string>>;
}

export class TestHost extends WorkerEntrypoint<Cloudflare.Env, TestHostProps> {
  async startRun(): Promise<boolean> {
    runtimeLifecycleEvents.push("lifecycle:in_progress");
    return true;
  }

  async terminal(runId: string): Promise<TerminalIdentity> {
    return {
      accountId: "test-account",
      repositoryId: `remote:${repositoryFixture.remote}`,
      workflowId: "commands",
      runId,
      trustId: `remote:${repositoryFixture.remote}`,
      generation: 1,
    };
  }

  async claimTerminal(_runId: string, candidate: TerminalRecord): Promise<TerminalRecord> {
    return candidate;
  }

  async readTerminal(): Promise<undefined> {
    return undefined;
  }

  async publishTerminal(_runId: string, finalization: Finalization): Promise<void> {
    runtimeLifecycleEvents.push(`lifecycle:${finalization.outcome}`);
  }

  async secrets(): Promise<Readonly<Record<string, string>>> {
    return { ...this.ctx.props.secrets, SANDBOX_SECRET: currentHostSecret };
  }

  async captureSecrets(runId: string): Promise<string> {
    if (failSecretCapture) throw new Error("setup capture failure");
    const snapshot = crypto.randomUUID();
    secretSnapshots.set(`${runId}:${snapshot}`, await this.secrets());
    return snapshot;
  }

  async restoreSecrets(runId: string, snapshot: string): Promise<Readonly<Record<string, string>>> {
    if (failNextSecretRestore) {
      failNextSecretRestore = false;
      throw new Error("setup restore failure");
    }
    if (failNextSecretValidation) {
      failNextSecretValidation = false;
      return {};
    }
    const secrets = secretSnapshots.get(`${runId}:${snapshot}`);
    if (!secrets) throw new Error("invalid secret snapshot");
    return secrets;
  }

  async source(): Promise<SourceIdentity> {
    return await this.env.RUNWAY_TEST_SANDBOX.source();
  }

  async prepareSource(request: {
    runId: string;
    source: SourceIdentity;
    secrets: Readonly<Record<string, string>>;
    allowReconstruct: boolean;
  }): Promise<PreparedSource> {
    return await this.env.RUNWAY_TEST_SANDBOX.prepareSource(request);
  }

  async execute(
    request: Omit<SandboxRequest, "secrets"> & {
      secrets: Readonly<Record<string, string>>;
    },
  ): Promise<ExecResult> {
    const secrets = Object.values(request.secrets);
    if (request.options.command === "snapshot-output") {
      return {
        exitCode: 0,
        stdout: secrets.reduce(
          (output, secret) => output.replaceAll(secret, "***"),
          "sandbox-secret",
        ),
        stderr: "",
        durationMs: 1,
      };
    }
    return await this.env.RUNWAY_TEST_SANDBOX.exec({
      ...request,
      secrets,
    });
  }

  async destroy(runId: string, secrets: Readonly<Record<string, string>>): Promise<void> {
    lastHostDestroySecrets = Object.values(secrets);
    await this.env.RUNWAY_TEST_SANDBOX.destroy(runId, lastHostDestroySecrets);
  }

  rotateSecret(value: string): void {
    currentHostSecret = value;
  }

  resetSecret(): void {
    currentHostSecret = "sandbox-secret";
    lastHostDestroySecrets = [];
    secretSnapshots.clear();
    failSecretCapture = false;
    failNextSecretRestore = false;
    failNextSecretValidation = false;
  }

  failSecretCapturePermanently(): void {
    failSecretCapture = true;
  }

  failSecretRestoreOnce(): void {
    failNextSecretRestore = true;
  }

  failSecretValidationOnce(): void {
    failNextSecretValidation = true;
  }

  destroySecrets(): ReadonlyArray<string> {
    return lastHostDestroySecrets;
  }

  lifecycleEvents(): ReadonlyArray<string> {
    return runtimeLifecycleEvents;
  }
}

export class CapabilityProbe extends WorkerEntrypoint<Cloudflare.Env> {
  async invoke(name: string, args: ReadonlyArray<unknown>): Promise<string> {
    const capability = this.env.GENERATED_ISSUE_HOST as unknown as Record<
      string,
      (...values: ReadonlyArray<unknown>) => Promise<unknown>
    >;
    try {
      await capability[name]!(...args);
      return "invoked";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

const issueSchema: StandardSchemaV1<unknown, { action: string; normalized: true }> = {
  "~standard": {
    version: 1,
    vendor: "runway-test",
    validate: (value) => {
      const event = value as { action?: unknown };
      return typeof event.action === "string"
        ? { value: { action: event.action, normalized: true } }
        : { issues: [{ message: "action is required" }] };
    },
  },
};

let issueGateEvaluations = 0;
let runLoaderExecutions = 0;

export const issueCreated = workflow({
  id: "issue-created",
  secrets: ["HOOK_SECRET", "API_KEY"],
  trigger: (ctx) =>
    webhook({
      path: "/issues",
      secret: ctx.secrets.HOOK_SECRET,
      signatureHeader: "x-signature",
      schema: issueSchema,
      timestamp: { source: "header", field: "x-timestamp", toleranceMs: 60_000 },
    }).filter((event): event is typeof event => {
      issueGateEvaluations += 1;
      return event.action === "create";
    }),
}).run(async (run, event) => {
  await run.do("run-loader-state", () => ++runLoaderExecutions);
  await run.do("trigger-loader-state", () => issueGateEvaluations);
  await run.do("record-issue", () => ({
    stepId: "record-issue",
    runId: run.runId,
    apiKey: run.secrets.API_KEY,
    envKeys: [],
    event,
  }));
  await run.sleep("settle", 1);
});

export const suspendedIssueCreated = workflow({
  id: "suspended-workflow",
  secrets: ["SANDBOX_SECRET"],
  trigger: () => cron("0 0 * * *"),
}).run(async (run) => {
  await run.do("artifact-version", () => "suspended");
  await run.do("historical-secret", () => run.secrets.SANDBOX_SECRET);
});

export class IssueCreatedWorkflow extends toEntrypoint(issueCreated) {}

const githubEvents = [
  {
    type: "push" as const,
    branches: ["main", "develop", "release-a", "release-b", "prune-trigger"],
  },
  { type: "pull_request" as const, actions: ["opened", "reopened", "synchronize"] as const },
] as const;

export const githubCheck = workflow({
  id: "github-check",
  trigger: () => github({ checkName: "Check", events: githubEvents }),
}).run(async () => {});

export const githubTest = workflow({
  id: "github-test",
  trigger: () => github({ checkName: "Test", events: githubEvents }),
}).run(async () => {
  throw new Error("GitHub handler failure");
});

const daily = workflow({ id: "daily", trigger: () => cron("0 9 * * *") }).run(
  async (run, event) => {
    await run.do("record-schedule", () => event);
  },
);

export class DailyWorkflow extends toEntrypoint(daily) {}

interface CommandEvent {
  commands: ReadonlyArray<string | ExecOptions>;
  catchErrors?: boolean;
  pauseMs?: number;
  throwAfterCommands?: boolean;
  throwUndefinedAfterCommands?: boolean;
}

const commands = workflow({
  id: "commands",
  secrets: ["SANDBOX_SECRET"],
  trigger: () => cron("0 0 * * *"),
}).run(async (run, event) => {
  const { catchErrors, commands, pauseMs, throwAfterCommands, throwUndefinedAfterCommands } =
    event as unknown as CommandEvent;
  runtimeLifecycleEvents.push("handler:start");
  for (const [index, command] of commands.entries()) {
    try {
      await run.exec(`command-${index}`, command);
    } catch (error) {
      if (!catchErrors) throw error;
      await run.do("caught-error", () =>
        error instanceof ExecError && error.command.includes("leak")
          ? {
              name: error.name,
              message: error.message,
              command: error.command,
              stdout: error.result.stdout,
              stderr: error.result.stderr,
            }
          : {
              name: error instanceof Error ? error.name : undefined,
              typed: error instanceof ExecError,
            },
      );
    }
    if (index === 0 && pauseMs !== undefined) await run.sleep("pause", pauseMs);
  }
  if (throwAfterCommands) throw new Error("handler failure");
  if (throwUndefinedAfterCommands) throw undefined;
  runtimeLifecycleEvents.push("handler:success");
});

export class CommandWorkflow extends toEntrypoint(commands) {}

const secretSnapshot = workflow({
  id: "secret-snapshot",
  secrets: ["SANDBOX_SECRET"],
  trigger: () => cron("0 0 * * *"),
}).run(async (run) => {
  await run.do("resolved-secret", () => run.secrets.SANDBOX_SECRET);
  await run.sleep("rotate-secret", 100);
  await run.exec("snapshot-output", "snapshot-output");
});

export class SecretSnapshotWorkflow extends toEntrypoint(secretSnapshot) {}

export default createRouter([
  { id: issueCreated.id, binding: "ISSUE_CREATED", trigger: issueCreated.trigger },
  { id: daily.id, binding: "DAILY", trigger: daily.trigger },
]);
