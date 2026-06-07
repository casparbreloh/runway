import { hmac, webhook, workflow } from "runway";
import { z } from "zod";

// Linear issue -> coding agent -> draft PR -> comment back. Authored as a real, step-based
// workflow: the trigger is a first-class typed field, and `event.payload` is inferred from
// its schema. Typechecking this file IS the validation — a wrong step is a compile error.

const REPO = "acme/widgets";
const COMMENT =
  "mutation($id:String!,$body:String!){commentCreate(input:{issueId:$id,body:$body}){success}}";

export default workflow({
  name: "linear-to-pr",
  trigger: webhook({
    path: "/hooks/linear",
    schema: z.object({
      data: z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        description: z.string(),
      }),
    }),
    verify: hmac((env) => env.LINEAR_SIGNING_SECRET, { header: "linear-signature" }),
  }),
  run: async (event, step, env) => {
    const { data } = event.payload; // typed: { id, identifier, title, description }

    // Fork the working repo into an isolated per-issue artifact, clone it into a sandbox,
    // let the agent do the work, open a PR, and report the link back to Linear.
    const repo = await step.artifact.fork("repo", { from: REPO, as: data.identifier });
    const box = await step.sandbox("clone", { from: repo, branch: `runway/${data.identifier}` });
    await step.agent("code", { sandbox: box, prompt: `${data.title}\n\n${data.description}` });
    const pr = await step.git.pr("open-pr", { sandbox: box, repo: REPO, title: data.title });

    await step.http("comment", {
      url: "https://api.linear.app/graphql",
      method: "POST",
      headers: { authorization: env.LINEAR_TOKEN },
      json: {
        query: COMMENT,
        variables: { id: data.id, body: `Runway → ${pr.url ?? "(no PR opened)"}` },
      },
    });
  },
});
