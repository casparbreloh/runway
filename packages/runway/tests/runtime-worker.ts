import type { StandardSchemaV1 } from "@standard-schema/spec";
import { WorkerEntrypoint } from "cloudflare:workers";
import { cron, ExecError, webhook, workflow } from "runway";
import type { ExecOptions, ExecResult } from "runway";
import { createRouter, toEntrypoint, watchWorkflowCancellation } from "runway/runtime";
import type { NormalizedExecOptions } from "runway/runtime";

const runnerState = {
  executions: [] as Array<{
    runId: string;
    options: NormalizedExecOptions;
    secrets: ReadonlyArray<string>;
  }>,
  destroys: [] as string[],
  kills: [] as string[],
};

export class TestRunner extends WorkerEntrypoint<Cloudflare.Env> {
  async exec(
    runId: string,
    options: NormalizedExecOptions,
    secrets: ReadonlyArray<string>,
  ): Promise<ExecResult> {
    runnerState.executions.push({ runId, options, secrets });
    if (options.command === "block") {
      let completed = false;
      let unblock: (() => void) | undefined;
      this.ctx.waitUntil(
        watchWorkflowCancellation(
          async () => await (await this.env.RUNNER.get(runId)).status(),
          {
            killAllProcesses: async () => {
              runnerState.kills.push(runId);
              unblock?.();
            },
            destroy: async () => {
              runnerState.destroys.push(runId);
            },
          },
          () => completed,
          10,
        ),
      );
      try {
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
      } finally {
        completed = true;
      }
    }
    if (options.command === "exit 7") {
      return { exitCode: 7, stdout: "tail", stderr: "failed", durationMs: 4 };
    }
    return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 8 };
  }

  async destroy(runId: string): Promise<void> {
    runnerState.destroys.push(runId);
  }

  state(): typeof runnerState {
    return runnerState;
  }

  reset(): void {
    runnerState.executions = [];
    runnerState.destroys = [];
    runnerState.kills = [];
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
}

const runner = workflow({
  id: "runner",
  secrets: ["RUNNER_SECRET"],
  trigger: () => cron("0 0 * * *"),
}).handler(async (ctx, event) => {
  const { catchErrors, commands } = event as unknown as RunnerEvent;
  for (const [index, command] of commands.entries()) {
    try {
      await ctx.step.exec(`command-${index}`, command);
    } catch (error) {
      if (!catchErrors) throw error;
      await ctx.step.do("caught-error", () => ({
        name: error instanceof Error ? error.name : undefined,
        typed: error instanceof ExecError,
      }));
    }
  }
});

export class RunnerWorkflow extends toEntrypoint(runner) {}

export default createRouter([
  { id: issueCreated.id, binding: "ISSUE_CREATED", trigger: issueCreated.trigger },
  { id: daily.id, binding: "DAILY", trigger: daily.trigger },
]);
