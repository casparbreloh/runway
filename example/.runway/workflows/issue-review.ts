import { LinearClient } from "@linear/sdk";
import type { EntityWebhookPayloadWithIssueData, LinearWebhookPayload } from "@linear/sdk/webhooks";
import { OpenRouter } from "@openrouter/sdk";
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
  const review = await ctx.step("review", async () => {
    const openrouter = new OpenRouter({ apiKey: ctx.secrets.OPENROUTER_API_KEY });
    const result = await openrouter.chat.send({
      chatRequest: {
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "system",
            content:
              "Review this Linear issue as a senior engineer: clarity, completeness, feasibility, missing acceptance criteria, hidden scope. Reply with a concise markdown comment of a few bullets, no preamble.",
          },
          {
            role: "user",
            content: `# ${issue.identifier}: ${issue.title}\n\n${issue.description ?? "(no description)"}`,
          },
        ],
      },
    });
    const content = result.choices[0]?.message.content;
    return typeof content === "string" ? content.trim() : "";
  });
  await ctx.step("comment", async () => {
    const linear = new LinearClient({ apiKey: ctx.secrets.LINEAR_API_KEY });
    await linear.createComment({ issueId: issue.id, body: review });
  });
});
