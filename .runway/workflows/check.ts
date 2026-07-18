import { github, mise, workflow } from "runway";

export default workflow({
  id: "check",
  tools: mise({ node: "26.5.0", pnpm: "11.5.0" }),
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
    command: "pnpm install --frozen-lockfile --reporter=append-only",
    env: { NODE_OPTIONS: "--max-old-space-size=128" },
  });
  await step.exec("format-check", "pnpm format-check");
  await step.exec("lint", "pnpm lint");
  await step.exec("typecheck", "pnpm typecheck");
  await step.exec("fallow", "pnpm fallow");
});
