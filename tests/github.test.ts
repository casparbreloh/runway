import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { GitHub, GitHubLive, type GitHubConfig, type GitHubService } from "../src/GitHub.ts";

interface Call {
  method: string;
  params: any;
}

const makeFake = (listData: ReadonlyArray<any>) => {
  const calls: Call[] = [];
  const octokit = {
    rest: {
      pulls: {
        list: async (params: any) => {
          calls.push({ method: "list", params });
          return { data: listData };
        },
        create: async (params: any) => {
          calls.push({ method: "create", params });
          return { data: { number: 7, html_url: "u", draft: true } };
        },
        update: async (params: any) => {
          calls.push({ method: "update", params });
          return { data: { number: 7, html_url: "u", draft: true } };
        },
      },
      issues: {
        createComment: async (params: any) => {
          calls.push({ method: "createComment", params });
          return {};
        },
      },
    },
  };
  return { octokit, calls };
};

const config = (octokit: unknown): GitHubConfig => ({ token: "t", owner: "acme", repo: "runway", octokit });

const run = <A>(eff: Effect.Effect<A, unknown, GitHubService>, cfg: GitHubConfig): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(GitHubLive(cfg))));

describe("GitHubLive", () => {
  it("findOpenPR returns null on empty list and queries with owner-qualified head", async () => {
    const { octokit, calls } = makeFake([]);
    const result = await run(
      Effect.flatMap(GitHub, (gh) => gh.findOpenPR("feature-x")),
      config(octokit),
    );
    expect(result).toBeNull();
    expect(calls[0].method).toBe("list");
    expect(calls[0].params.head).toBe("acme:feature-x");
    expect(calls[0].params.state).toBe("open");
  });

  it("createOrUpdateDraftPR creates a draft PR when none open (number 7)", async () => {
    const { octokit, calls } = makeFake([]);
    const result = await run(
      Effect.flatMap(GitHub, (gh) =>
        gh.createOrUpdateDraftPR({ head: "feature-x", base: "main", title: "T", body: "B" }),
      ),
      config(octokit),
    );
    expect(result).toEqual({ number: 7, html_url: "u", draft: true });
    expect(calls.map((c) => c.method)).toEqual(["list", "create"]);
    expect(calls[1].params.draft).toBe(true);
    expect(calls[1].params.head).toBe("feature-x");
    expect(calls[1].params.base).toBe("main");
  });

  it("createOrUpdateDraftPR updates the existing PR when one is open", async () => {
    const { octokit, calls } = makeFake([{ number: 7, html_url: "u", draft: true }]);
    const result = await run(
      Effect.flatMap(GitHub, (gh) =>
        gh.createOrUpdateDraftPR({ head: "feature-x", base: "main", title: "T2", body: "B2" }),
      ),
      config(octokit),
    );
    expect(result).toEqual({ number: 7, html_url: "u", draft: true });
    expect(calls.map((c) => c.method)).toEqual(["list", "update"]);
    expect(calls[1].params.pull_number).toBe(7);
    expect(calls[1].params.title).toBe("T2");
    expect(calls[1].params.body).toBe("B2");
  });

  it("postComment calls issues.createComment with the issue number and body", async () => {
    const { octokit, calls } = makeFake([]);
    const result = await run(
      Effect.flatMap(GitHub, (gh) => gh.postComment(42, "hello")),
      config(octokit),
    );
    expect(result).toBeUndefined();
    expect(calls[0].method).toBe("createComment");
    expect(calls[0].params.issue_number).toBe(42);
    expect(calls[0].params.body).toBe("hello");
  });
});
