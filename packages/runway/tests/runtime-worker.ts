import type { StandardSchemaV1 } from "@standard-schema/spec";
import { WorkerEntrypoint } from "cloudflare:workers";
import { cron, ExecError, webhook, workflow } from "runway";
import type { ExecOptions, ExecResult } from "runway";
import { toEntrypoint } from "runway/runtime";

import { createRouter } from "../src/router.ts";

export { RunnerAdapterHarness } from "./runner-adapter-harness.ts";

interface NormalizedExecOptions {
  command: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}

interface RunnerRequest {
  runId: string;
  step: { id: string; count: number; attempt: number };
  options: NormalizedExecOptions;
  secrets: ReadonlyArray<string>;
}

const runnerState = {
  executions: [] as Array<{
    runId: string;
    step: { id: string; count: number; attempt: number };
    options: NormalizedExecOptions;
    secrets: ReadonlyArray<string>;
  }>,
  destroys: [] as string[],
  kills: [] as string[],
};
const activeExecutions = new Map<string, () => void>();
const runnerWorkspaces = new Map<string, string>();
const secretSnapshots = new Map<string, Readonly<Record<string, string>>>();
let destroyAttempts = 0;
let failNextDestroy = false;
let currentHostSecret = "runner-secret";
let lastHostDestroySecrets: ReadonlyArray<string> = [];

export class TestRunner extends WorkerEntrypoint<Cloudflare.Env> {
  async exec(request: RunnerRequest): Promise<ExecResult> {
    const { runId, step, options, secrets } = request;
    runnerState.executions.push({ runId, step, options, secrets });
    if (options.command === "block") {
      const blocked = new Promise<void>((resolve) => activeExecutions.set(runId, resolve));
      this.ctx.waitUntil(
        (async () => {
          while (activeExecutions.has(runId)) {
            await scheduler.wait(10);
            if ((await (await this.env.RUNNER.get(runId)).status()).status === "terminated") {
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
    if (options.command.includes("runner-secret")) {
      return {
        exitCode: 9,
        stdout: "stdout runner-secret",
        stderr: "stderr runner-secret",
        durationMs: 4,
      };
    }
    if (options.command === "echo hello > state.txt") {
      runnerWorkspaces.set(runId, "hello\n");
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 2 };
    }
    if (options.command === "cat state.txt") {
      const state = runnerWorkspaces.get(runId);
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
    destroyAttempts += 1;
    if (failNextDestroy) {
      failNextDestroy = false;
      throw new Error("transient destroy failure");
    }
    const unblock = activeExecutions.get(runId);
    if (unblock) {
      runnerState.kills.push(runId);
      activeExecutions.delete(runId);
      unblock();
    }
    runnerState.destroys.push(runId);
    runnerWorkspaces.delete(runId);
  }

  state(): typeof runnerState {
    return runnerState;
  }

  reset(): void {
    runnerState.executions = [];
    runnerState.destroys = [];
    runnerState.kills = [];
    activeExecutions.clear();
    runnerWorkspaces.clear();
    destroyAttempts = 0;
    failNextDestroy = false;
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
  async secrets(): Promise<Readonly<Record<string, string>>> {
    return { ...this.ctx.props.secrets, RUNNER_SECRET: currentHostSecret };
  }

  async captureSecrets(runId: string): Promise<string> {
    const snapshot = crypto.randomUUID();
    secretSnapshots.set(`${runId}:${snapshot}`, await this.secrets());
    return snapshot;
  }

  async restoreSecrets(runId: string, snapshot: string): Promise<Readonly<Record<string, string>>> {
    const secrets = secretSnapshots.get(`${runId}:${snapshot}`);
    if (!secrets) throw new Error("invalid secret snapshot");
    return secrets;
  }

  async exec(
    request: Omit<RunnerRequest, "secrets"> & {
      secrets: Readonly<Record<string, string>>;
    },
  ): Promise<ExecResult> {
    const secrets = Object.values(request.secrets);
    if (request.options.command === "snapshot-output") {
      return {
        exitCode: 0,
        stdout: secrets.reduce(
          (output, secret) => output.replaceAll(secret, "***"),
          "runner-secret",
        ),
        stderr: "",
        durationMs: 1,
      };
    }
    return await this.env.RUNWAY_TEST_RUNNER.exec({
      ...request,
      secrets,
    });
  }

  async destroy(runId: string, secrets: Readonly<Record<string, string>>): Promise<void> {
    lastHostDestroySecrets = Object.values(secrets);
    await this.env.RUNWAY_TEST_RUNNER.destroy(runId, lastHostDestroySecrets);
  }

  rotateSecret(value: string): void {
    currentHostSecret = value;
  }

  resetSecret(): void {
    currentHostSecret = "runner-secret";
    lastHostDestroySecrets = [];
    secretSnapshots.clear();
  }

  destroySecrets(): ReadonlyArray<string> {
    return lastHostDestroySecrets;
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
}).handler(async (ctx, event) => {
  await ctx.step.do("trigger-loader-state", () => issueGateEvaluations);
  await ctx.step.do("record-issue", (step) => ({
    stepId: step.id,
    runId: ctx.runId,
    apiKey: ctx.secrets.API_KEY,
    envKeys: Object.keys(ctx.env as Record<string, unknown>).sort(),
    event,
  }));
  await ctx.step.sleep("settle", 1);
});

export const suspendedIssueCreated = workflow({
  id: "suspended-workflow",
  secrets: ["RUNNER_SECRET"],
  trigger: () => cron("0 0 * * *"),
}).handler(async (ctx) => {
  await ctx.step.do("artifact-version", () => "suspended");
  await ctx.step.do("historical-secret", () => ctx.secrets.RUNNER_SECRET);
});

export class IssueCreatedWorkflow extends toEntrypoint(issueCreated) {}

const daily = workflow({ id: "daily", trigger: () => cron("0 9 * * *") }).handler(
  async (ctx, event) => {
    await ctx.step.do("record-schedule", () => event);
  },
);

export class DailyWorkflow extends toEntrypoint(daily) {}

interface RunnerEvent {
  commands: ReadonlyArray<string | ExecOptions>;
  catchErrors?: boolean;
  pauseMs?: number;
}

const runner = workflow({
  id: "runner",
  secrets: ["RUNNER_SECRET"],
  trigger: () => cron("0 0 * * *"),
}).handler(async (ctx, event) => {
  const { catchErrors, commands, pauseMs } = event as unknown as RunnerEvent;
  for (const [index, command] of commands.entries()) {
    try {
      using _result = (await ctx.step.exec(`command-${index}`, command)) as ExecResult & Disposable;
    } catch (error) {
      if (!catchErrors) throw error;
      await ctx.step.do("caught-error", () =>
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
    if (index === 0 && pauseMs !== undefined) await ctx.step.sleep("pause", pauseMs);
  }
});

export class RunnerWorkflow extends toEntrypoint(runner) {}

const secretSnapshot = workflow({
  id: "secret-snapshot",
  secrets: ["RUNNER_SECRET"],
  trigger: () => cron("0 0 * * *"),
}).handler(async (ctx) => {
  await ctx.step.do("resolved-secret", () => ctx.secrets.RUNNER_SECRET);
  await ctx.step.sleep("rotate-secret", 100);
  await ctx.step.exec("snapshot-output", "snapshot-output");
});

export class SecretSnapshotWorkflow extends toEntrypoint(secretSnapshot) {}

export default createRouter([
  { id: issueCreated.id, binding: "ISSUE_CREATED", trigger: issueCreated.trigger },
  { id: daily.id, binding: "DAILY", trigger: daily.trigger },
]);
