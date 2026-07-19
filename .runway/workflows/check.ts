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
  await step.exec("format-check", "mise run format-check");
  await step.exec("lint", "mise run lint");
  await step.exec("typecheck", "mise run typecheck");
  await step.exec("fallow", "mise run fallow");
});
