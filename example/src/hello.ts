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
}).handler(async (ctx) => {
  const greeting = await ctx.step("greet", () => "hello");
  await ctx.sleep(5000);
  await ctx.step("finish", () => `${greeting} world (run ${ctx.runId})`);
});
