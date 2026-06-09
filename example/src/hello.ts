import { createWorkflow } from "@runway/core";

export default createWorkflow({ id: "hello" }).handler(async (ctx) => {
  const greeting = await ctx.step("greet", () => "hello");
  await ctx.sleep(5000);
  await ctx.step("finish", () => `${greeting} world (run ${ctx.runId})`);
});
