import { LinearClient } from "@linear/sdk";
import type { EntityWebhookPayloadWithIssueData } from "@linear/sdk/webhooks";
import { hmac, webhook, workflow } from "runway";

// Linear issue -> coding agent -> PR -> comment back, written as plain code. The trigger is a
// first-class field; the payload is typed by Linear's own SDK type. The primitives are only
// the things a Worker can't do itself (sandbox, shell, agent); everything else is just code.

const REPO = "acme/widgets";
const DIR = "/workspace/repo";

// git auth via a credential helper reading $GITHUB_TOKEN from the per-command env (the token
// never reaches argv). Issue-derived data is passed through env too — $BRANCH, $MSG.
const CLONE = [
  `git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'`,
  `git clone "https://github.com/$REPO" ${DIR}`,
  `cd ${DIR} && git checkout -b "$BRANCH"`,
].join(" && ");

const PUSH = [
  `cd ${DIR}`,
  `git add -A`,
  `git -c user.email=runway@local -c user.name=Runway commit -m "$MSG"`,
  `git push -u origin "$BRANCH"`,
].join(" && ");

export default workflow({
  name: "linear-to-pr",
  trigger: webhook<EntityWebhookPayloadWithIssueData>({
    path: "/hooks/linear",
    verify: hmac((env) => env.LINEAR_SIGNING_SECRET, { header: "linear-signature" }),
  }),
  run: async (event, step, env) => {
    const issue = event.payload.data; // typed Linear Issue webhook payload
    const branch = `runway/${issue.identifier}`;
    const sh = { GITHUB_TOKEN: env.GITHUB_TOKEN, REPO, BRANCH: branch, MSG: issue.title };

    const box = await step.sandbox("box");
    await step.shell("clone", { sandbox: box, env: sh, cmd: CLONE });
    await step.agent("code", {
      sandbox: box,
      cwd: DIR,
      apiKey: env.ANTHROPIC_API_KEY,
      prompt: `${issue.title}\n\n${issue.description ?? ""}`,
    });
    await step.shell("push", { sandbox: box, env: sh, cmd: PUSH });

    // Open the PR with a plain GitHub REST call (the http primitive — no gh, no SDK needed).
    const pr = await step.http("pr", {
      url: `https://api.github.com/repos/${REPO}/pulls`,
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "user-agent": "runway",
        accept: "application/vnd.github+json",
      },
      json: { title: issue.title, head: branch, base: "main", body: "Opened by Runway 🛫" },
    });
    const prUrl = (pr.json as { html_url?: string }).html_url ?? "(PR pending)";

    // Comment back to Linear — just import the SDK and call it inside a durable step.
    await step.do("comment", async () => {
      const linear = new LinearClient({ apiKey: env.LINEAR_TOKEN });
      const res = await linear.createComment({
        issueId: issue.id,
        body: `Runway opened a PR → ${prUrl}`,
      });
      return { success: res.success };
    });
  },
});
