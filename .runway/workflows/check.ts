import { github, mise, workflow } from "runway";

export default workflow({
  id: "check",
  tools: mise(),
  trigger: () =>
    github({
      checkName: "Check",
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
  await step.exec("format-check", "mise run --no-deps format-check");
  await step.exec("lint", "mise run --no-deps lint");
  await step.exec("typecheck", "mise run --no-deps typecheck");
  await step.exec("fallow", "mise run --no-deps fallow");
});
