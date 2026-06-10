import { createWorkflow, hmacSha256, webhook } from "@runway/core";

export default createWorkflow({
  id: "hello",
  trigger: webhook({
    path: "/hello",
    auth: hmacSha256({
      header: "linear-signature",
      secret: "LINEAR_WEBHOOK_SECRET",
      timestamp: { field: "webhookTimestamp", toleranceMs: 60_000 },
    }),
  }),
  secrets: ["LINEAR_API_KEY"],
}).handler(async (ctx) => {
  const viewer = await ctx.step("viewer", async () => {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: ctx.secrets.LINEAR_API_KEY },
      body: JSON.stringify({ query: "{ viewer { displayName } }" }),
    });
    const body = (await res.json()) as { data?: { viewer?: { displayName?: string } } };
    return body.data?.viewer?.displayName ?? "anonymous";
  });
  await ctx.sleep(5000);
  await ctx.step("finish", () => `hello ${viewer} (run ${ctx.runId})`);
});
