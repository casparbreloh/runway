import type { Env } from "../env.ts";
import type { GitPrArgs, PrResult } from "./types.ts";
import { assertSafeRef, redact, sandboxFor } from "./util.ts";

const BODY_PATH = "/work/pr-body.md";

// Commit the agent's work, push the branch to GitHub, and open a PR. Artifacts can't open
// PRs, so the human-facing destination is plain git + `gh` against github.com.
export const runGitPr = async (env: Env, args: GitPrArgs): Promise<PrResult> => {
  const { branch, base, dir, id } = args.sandbox;
  assertSafeRef(branch, base);
  const sandbox = sandboxFor(env, id);

  await sandbox.setEnvVars({
    GH_TOKEN: env.GITHUB_TOKEN,
    RUNWAY_PR_TITLE: args.title,
  });

  // Stage everything except the agent's PR.md scratch file; bail early if nothing changed.
  await sandbox.exec(`cd ${dir} && rm -f PR.md && git add -A`);
  const staged = await sandbox.exec(`cd ${dir} && git diff --cached --quiet`);
  if (staged.exitCode === 0) return { pushed: false };

  const commit = await sandbox.exec(`cd ${dir} && git commit -m "$RUNWAY_PR_TITLE"`);
  if (commit.exitCode !== 0) throw new Error(`commit failed: ${redact(commit.stderr)}`);

  const remote = `https://x-access-token:${env.GITHUB_TOKEN}@github.com/${args.repo}.git`;
  const push = await sandbox.exec(
    `cd ${dir} && git push ${remote} HEAD:${branch} --force-with-lease`,
  );
  if (push.exitCode !== 0) return { pushed: false };

  await sandbox.writeFile(BODY_PATH, args.body ?? "Automated PR by Runway.");
  const draft = args.draft === false ? "" : "--draft ";
  const pr = await sandbox.exec(
    `cd ${dir} && gh pr create ${draft}--repo ${args.repo} --base ${base} --head ${branch} ` +
      `--title "$RUNWAY_PR_TITLE" --body-file ${BODY_PATH} || ` +
      `gh pr view ${branch} --repo ${args.repo} --json url --jq .url`,
  );

  const url = pr.stdout.trim().split("\n").filter(Boolean).pop()?.trim();
  if (!url || !url.startsWith("https://")) return { pushed: true };

  const number = Number.parseInt(url.split("/").pop() ?? "", 10);
  return { pushed: true, url, ...(Number.isInteger(number) ? { number } : {}) };
};
