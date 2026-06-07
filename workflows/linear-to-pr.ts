import { workflow } from "@runway/engine";
import * as git from "@runway/git";

// The Linear -> PR flow, authored with the recorder DSL. A malformed step here is a
// type error: this file compiling IS the validation. Mirrors the hand-written
// declarative manifest in src/flows.ts step-for-step, composed fluently.
const REPO = "acme/widgets";
const BRANCH = "runway/{{ body.data.identifier }}";

export default workflow(
  "linear-to-pr",
  (s) => {
    // One run step (pr: true) clones, runs the agent, commits, pushes and opens a
    // draft PR via the interpreter's built-in git pipeline; `pr.ref("prUrl")` is the
    // parsed PR url it stores back as steps.pr.prUrl.
    const pr = git.pr(s, {
      id: "pr",
      prompt: "{{ body.data.title }}\n\n{{ body.data.description }}",
      branch: BRANCH,
    });
    s.http({
      id: "comment",
      url: "https://api.linear.app/graphql",
      method: "POST",
      headers: { authorization: "{{ secrets.linear }}", "content-type": "application/json" },
      json: {
        query:
          "mutation($id:String!,$b:String!){commentCreate(input:{issueId:$id,body:$b}){success}}",
        variables: { id: "{{ body.data.id }}", b: `Runway -> ${pr.ref("prUrl")}` },
      },
    });
  },
  { repo: REPO, agent: "codex" },
);
