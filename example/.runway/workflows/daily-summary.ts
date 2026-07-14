import { cron, workflow } from "runway";

export default workflow({
  id: "daily-summary",
  trigger: () => cron("0 9 * * *"),
}).handler(async (ctx, event) => {
  await ctx.step.exec("runtime", "node --version");
  await ctx.step.do("record-schedule", () => ({
    runId: ctx.runId,
    cron: event.cron,
    scheduledTime: event.scheduledTime,
  }));
});
