import type { FlowManifest } from "./flow/manifest.ts";

// Fully generic: the webhook is verified by `trigger.sign`, filtered by `when`, and
// the steps read the payload via `{{ body.* }}`. No Linear-specific code anywhere —
// swap the endpoints/fields and this is a GitHub or Slack flow.
export const linearToPr: FlowManifest = {
  id: "linear-to-pr",
  trigger: {
    webhook: {
      secret: "{{ secrets.linear_webhook }}",
      sign: { header: "linear-signature", alg: "sha256", encoding: "hex" },
      when: "{{ body.data.state.name == 'Runway' }}",
    },
  },
  repo: "acme/widgets",
  agent: "codex",
  steps: [
    {
      id: "pr",
      run: "{{ body.data.title }}\n\n{{ body.data.description }}",
      pr: true,
      branch: "runway/{{ body.data.identifier }}",
    },
    {
      id: "comment",
      http: {
        url: "https://api.linear.app/graphql",
        method: "POST",
        headers: { authorization: "{{ secrets.linear }}", "content-type": "application/json" },
        json: {
          query:
            "mutation($id:String!,$b:String!){commentCreate(input:{issueId:$id,body:$b}){success}}",
          variables: { id: "{{ body.data.id }}", b: "Runway → {{ steps.pr.prUrl }}" },
        },
      },
    },
  ],
};

export const clawsweeper: FlowManifest = {
  id: "clawsweeper",
  trigger: { cron: "0 9 * * *" },
  repo: "acme/widgets",
  agent: "codex",
  steps: [
    {
      id: "issues",
      shell:
        'gh issue list -R {{ repo }} --state open --search "sort:updated-asc" -L 20 --json number,title,body',
    },
    {
      id: "fix",
      forEach: "{{ steps.issues.json }}",
      run: 'Review issue #{{ item.number }} "{{ item.title }}": {{ item.body }} — if it is already resolved in the code, close it with `gh issue close` and a comment citing the evidence; if a small fix would resolve it, make the change.',
      pr: true,
    },
  ],
};

export const flows: readonly FlowManifest[] = [linearToPr, clawsweeper];

export const flowsById: Record<string, FlowManifest> = Object.fromEntries(
  flows.map((flow) => [flow.id, flow]),
);
