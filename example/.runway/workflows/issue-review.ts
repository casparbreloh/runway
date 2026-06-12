import { LinearClient } from "@linear/sdk";
import type { EntityWebhookPayloadWithIssueData, LinearWebhookPayload } from "@linear/sdk/webhooks";
import { webhook, workflow } from "runway";

export default workflow({
  id: "issue-review",
  secrets: ["LINEAR_WEBHOOK_SECRET", "LINEAR_API_KEY", "OPENROUTER_API_KEY"],
  trigger: (ctx) =>
    webhook<LinearWebhookPayload>({
      path: "/linear",
      secret: ctx.secrets.LINEAR_WEBHOOK_SECRET,
      signatureHeader: "linear-signature",
      timestamp: { field: "webhookTimestamp", toleranceMs: 60_000 },
    }).filter(
      (event): event is EntityWebhookPayloadWithIssueData =>
        "type" in event && event.type === "Issue" && event.action === "create",
    ),
}).handler(async (ctx, event) => {
  const issue = event.data;
  const review = await ctx.sandbox("review", async (sandbox) => {
    await sandbox.writeFile(
      "/workspace/issue.md",
      `# ${issue.identifier}: ${issue.title}\n\n${issue.description ?? "(no description)"}`,
    );
    const result = await sandbox.exec(
      [
        "npx --yes @earendil-works/pi-coding-agent@0.79.1",
        "--provider openrouter",
        "--model google/gemini-2.5-flash-lite",
        "--no-context-files",
        "--no-session",
        "-p",
        "@issue.md",
        JSON.stringify(
          "Review this Linear issue as a senior engineer: clarity, completeness, feasibility, missing acceptance criteria, hidden scope. Reply with a concise markdown comment of a few bullets, no preamble.",
        ),
      ].join(" "),
      {
        cwd: "/workspace",
        timeout: 120_000,
        env: { OPENROUTER_API_KEY: ctx.secrets.OPENROUTER_API_KEY },
      },
    );
    if (!result.success) throw new Error(result.stderr || `pi exited ${result.exitCode}`);
    return result.stdout.trim();
  });
  await ctx.step("comment", async () => {
    const linear = new LinearClient({ apiKey: ctx.secrets.LINEAR_API_KEY });
    await linear.createComment({ issueId: issue.id, body: review });
  });
});
