import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { Context, Effect, Layer } from "effect";

import { GitHubError, type PullRequest } from "./domain.ts";

const OctokitRest = Octokit.plugin(restEndpointMethods);

export interface GitHubService {
  readonly findOpenPR: (headBranch: string) => Effect.Effect<PullRequest | null, GitHubError>;
  readonly createOrUpdateDraftPR: (args: {
    head: string;
    base: string;
    title: string;
    body: string;
  }) => Effect.Effect<PullRequest, GitHubError>;
  readonly postComment: (issueNumber: number, body: string) => Effect.Effect<void, GitHubError>;
}

export const GitHub = Context.Service<GitHubService>("GitHub");
export type GitHub = (typeof GitHub)["Identifier"];

export interface GitHubConfig {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  readonly userAgent?: string;
  readonly octokit?: unknown;
}

const toPullRequest = (data: { number: number; html_url: string; draft?: boolean }): PullRequest =>
  data.draft === undefined
    ? { number: data.number, html_url: data.html_url }
    : { number: data.number, html_url: data.html_url, draft: data.draft };

const toGitHubError = (e: unknown): GitHubError =>
  new GitHubError({
    status: Number((e as any)?.status ?? 0),
    message: String((e as any)?.message ?? e),
  });

const buildService = (config: GitHubConfig): GitHubService => {
  const octokit =
    (config.octokit as any) ??
    new OctokitRest({ auth: config.token, userAgent: config.userAgent ?? "runway" });
  const { owner, repo } = config;

  const findOpenPR: GitHubService["findOpenPR"] = (headBranch) =>
    Effect.tryPromise({
      try: () =>
        octokit.rest.pulls.list({ owner, repo, head: `${owner}:${headBranch}`, state: "open" }),
      catch: toGitHubError,
    }).pipe(Effect.map((res: any) => (res.data[0] ? toPullRequest(res.data[0]) : null)));

  const createOrUpdateDraftPR: GitHubService["createOrUpdateDraftPR"] = (args) =>
    findOpenPR(args.head).pipe(
      Effect.flatMap((found) =>
        Effect.tryPromise({
          try: () =>
            found
              ? octokit.rest.pulls.update({
                  owner,
                  repo,
                  pull_number: found.number,
                  title: args.title,
                  body: args.body,
                })
              : octokit.rest.pulls.create({ owner, repo, ...args, draft: true }),
          catch: toGitHubError,
        }),
      ),
      Effect.map((res: any) => toPullRequest(res.data)),
    );

  const postComment: GitHubService["postComment"] = (issueNumber, body) =>
    Effect.tryPromise({
      try: () =>
        octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body }),
      catch: toGitHubError,
    }).pipe(Effect.asVoid);

  return { findOpenPR, createOrUpdateDraftPR, postComment };
};

export const GitHubLive = (config: GitHubConfig): Layer.Layer<GitHubService> =>
  Layer.sync(GitHub, () => buildService(config));
