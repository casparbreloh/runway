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
  await step.exec("install", {
    command: "mise run --no-deps deps:ci",
    env: { NODE_OPTIONS: "--max-old-space-size=128" },
  });
  await step.exec("test", {
    command: "mise run --no-deps test",
    env: { VITEST_MAX_WORKERS: "1" },
  });
});
