import type { StandardSchemaV1 } from "@standard-schema/spec";
import { WorkerEntrypoint } from "cloudflare:workers";
import { cron, ExecError, webhook, workflow } from "runway";
import type { ExecOptions, ExecResult } from "runway";
import { createRouter, toEntrypoint } from "runway/runtime";

export { RunnerAdapterHarness } from "./runner-adapter-harness.ts";

interface NormalizedExecOptions {
  command: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
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
let destroyAttempts = 0;
let failNextDestroy = false;

export class TestRunner extends WorkerEntrypoint<Cloudflare.Env> {
  async exec(request: {
    runId: string;
    step: { id: string; count: number; attempt: number };
    options: NormalizedExecOptions;
    secrets: ReadonlyArray<string>;
  }): Promise<ExecResult> {
    const { runId, step, options, secrets } = request;
    runnerState.executions.push({ runId, step, options, secrets });
    if (options.command === "block") {
      const blocked = new Promise<void>((resolve) => activeExecutions.set(runId, resolve));
      this.ctx.waitUntil(
        (async () => {
          while (activeExecutions.has(runId)) {
            await scheduler.wait(10);
            if ((await (await this.env.RUNNER.get(runId)).status()).status === "terminated") {
              await this.destroy(runId);
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

  async destroy(runId: string, _secrets?: ReadonlyArray<string>): Promise<void> {
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

  restart(runId: string): void {
    runnerWorkspaces.delete(runId);
  }

  failDestroyOnce(): void {
    failNextDestroy = true;
  }

  destroyAttempts(): number {
    return destroyAttempts;
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

const issueCreated = workflow({
  id: "issue-created",
  secrets: ["HOOK_SECRET", "API_KEY"],
  trigger: (ctx) =>
    webhook({
      path: "/issues",
      secret: ctx.secrets.HOOK_SECRET,
      signatureHeader: "x-signature",
      schema: issueSchema,
    }).filter((event): event is typeof event => event.action === "create"),
}).handler(async (ctx, event) => {
  await ctx.step.do("record-issue", (step) => ({
    stepId: step.id,
    runId: ctx.runId,
    apiKey: ctx.secrets.API_KEY,
    event,
  }));
  await ctx.step.sleep("settle", 1);
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
      await ctx.step.exec(`command-${index}`, command);
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

export default createRouter([
  { id: issueCreated.id, binding: "ISSUE_CREATED", trigger: issueCreated.trigger },
  { id: daily.id, binding: "DAILY", trigger: daily.trigger },
]);
