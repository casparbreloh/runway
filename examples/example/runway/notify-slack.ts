import { webhook, workflow } from "runway";

export default workflow({
  id: "notify-slack",
  secrets: ["SLACK_WEBHOOK_URL"],
  trigger: webhook<{ text: string }>({ path: "/hooks/notify" }),
  run: async (event, step, env) => {
    await step.http("post", {
      url: env.SLACK_WEBHOOK_URL,
      method: "POST",
      json: { text: event.payload.text },
    });
  },
});
