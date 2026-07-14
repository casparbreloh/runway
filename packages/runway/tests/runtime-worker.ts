import type { StandardSchemaV1 } from "@standard-schema/spec";
import { cron, webhook, workflow } from "runway";
import { createRouter, toEntrypoint } from "runway/runtime";

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

export default createRouter([
  { id: issueCreated.id, binding: "ISSUE_CREATED", trigger: issueCreated.trigger },
  { id: daily.id, binding: "DAILY", trigger: daily.trigger },
]);
