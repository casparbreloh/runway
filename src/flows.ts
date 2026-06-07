import type { FlowManifest } from "./flow/manifest.ts";

// The Linear comment-back is now a plain `http` step (no hardcoded GraphQL client):
// the flow declares the endpoint + `{{ secrets.linear }}`, the engine injects it.
export const linearToPr: FlowManifest = {
  id: "linear-to-pr",
  trigger: "linear",
  steps: [
    { id: "pr", run: "{{ plan }}", pr: true, branch: "runway/{{ ref }}" },
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
