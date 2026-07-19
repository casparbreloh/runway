import { github, mise, workflow } from "runway";

export default workflow({
  id: "test",
  tools: mise(),
  trigger: () =>
    github({
      checkName: "Test",
      events: [
        { type: "push", branches: ["main"] },
        { type: "pull_request", actions: ["opened", "reopened", "synchronize"] },
      ],
    }),
}).run(async (step) => {
  await step.exec("test", {
    command: "mise run test",
    env: { VITEST_MAX_WORKERS: "1" },
  });
});
