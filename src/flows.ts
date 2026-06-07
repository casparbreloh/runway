import type { FlowManifest } from "./flow/manifest.ts";

export const linearToPr: FlowManifest = {
  id: "linear-to-pr",
  trigger: "linear",
  steps: [{ run: "{{ plan }}", pr: true }, { report: true }],
};

export const clawsweeper: FlowManifest = {
  id: "clawsweeper",
  trigger: { cron: "0 9 * * *" },
  repo: "acme/widgets",
  agent: "codex",
  steps: [
    {
      shell:
        'gh issue list -R {{ repo }} --state open --search "sort:updated-asc" -L 20 --json number,title,body',
      as: "issues",
    },
    {
      forEach: "{{ issues }}",
      run: 'Review issue #{{ item.number }} "{{ item.title }}": {{ item.body }} — if it is already resolved in the code, close it with `gh issue close` and a comment citing the evidence; if a small fix would resolve it, make the change.',
      pr: true,
    },
  ],
};

export const flows: readonly FlowManifest[] = [linearToPr, clawsweeper];
