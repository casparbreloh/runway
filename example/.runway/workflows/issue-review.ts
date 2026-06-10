import type { SandboxEnv } from "@cloudflare/sandbox";
import { LinearClient } from "@linear/sdk";
import type { EntityWebhookPayloadWithIssueData, LinearWebhookPayload } from "@linear/sdk/webhooks";
import { createWorkflow, webhook } from "@runway/core";

const REVIEW_MODEL = "google/gemini-2.5-flash-lite";

const REVIEW_PROMPT =
  "Review this Linear issue as a senior engineer: clarity, completeness, feasibility, " +
  "missing acceptance criteria, hidden scope. Reply with a concise markdown comment of a " +
  "few bullets, no preamble.";

export default createWorkflow({
  id: "issue-review",
  secrets: ["LINEAR_WEBHOOK_SECRET", "LINEAR_API_KEY", "OPENROUTER_API_KEY"],
})
  .trigger(
    webhook(
      {
        path: "/linear",
        secret: "LINEAR_WEBHOOK_SECRET",
        header: "linear-signature",
        timestamp: { field: "webhookTimestamp", toleranceMs: 60_000 },
      },
      (event: LinearWebhookPayload) =>
        "type" in event && event.type === "Issue" && event.action === "create"
          ? (event as EntityWebhookPayloadWithIssueData).data
          : undefined,
    ),
  )
  .handler(async (ctx) => {
    const issue = ctx.params;
    const review = await ctx.step("review", async () => {
      const { getSandbox } = await import("@cloudflare/sandbox");
      const sandbox = getSandbox((ctx.env as SandboxEnv).Sandbox, ctx.runId);
      try {
        await sandbox.exec("npm install -g --ignore-scripts @earendil-works/pi-coding-agent", {
          timeout: 180_000,
        });
        await sandbox.writeFile(
          "/tmp/issue.md",
          `# ${issue.identifier}: ${issue.title}\n\n${issue.description ?? "(no description)"}`,
        );
        const result = await sandbox.exec(
          `pi --provider openrouter --model ${REVIEW_MODEL} --no-tools --no-session -p @/tmp/issue.md "${REVIEW_PROMPT}"`,
          { timeout: 300_000, env: { OPENROUTER_API_KEY: ctx.secrets.OPENROUTER_API_KEY } },
        );
        if (!result.success) throw new Error(`pi exited ${result.exitCode}: ${result.stderr}`);
        return result.stdout.trim();
      } finally {
        await sandbox.destroy();
      }
    });
    await ctx.step("comment", async () => {
      const linear = new LinearClient({ apiKey: ctx.secrets.LINEAR_API_KEY });
      await linear.createComment({ issueId: issue.id, body: review });
    });
  });
