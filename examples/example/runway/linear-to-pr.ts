import { LinearClient } from "@linear/sdk";
import type { EntityWebhookPayloadWithIssueData } from "@linear/sdk/webhooks";
import { hmac, webhook, workflow } from "runway";

const REPO = "acme/widgets";
const DIR = "/workspace/repo";

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
  id: "linear-to-pr",
  secrets: ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "LINEAR_TOKEN", "LINEAR_SIGNING_SECRET"],
  trigger: webhook<EntityWebhookPayloadWithIssueData>({
    path: "/hooks/linear",
    verify: hmac((env) => env.LINEAR_SIGNING_SECRET, { header: "linear-signature" }),
  }),
  run: async (event, step, env) => {
    const issue = event.payload.data;
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

    const pr = await step.http("pr", {
      url: `https://api.github.com/repos/${REPO}/pulls`,
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "user-agent": "runway",
        accept: "application/vnd.github+json",
      },
      json: { title: issue.title, head: branch, base: "main", body: "Opened by Runway" },
    });
    const prUrl = (JSON.parse(pr.text) as { html_url?: string }).html_url ?? "(PR pending)";

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
