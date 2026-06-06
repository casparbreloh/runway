/** Minimal GitHub REST client (raw fetch, no SDK) for draft-PR output in pi mode. */
export interface GitHubClient {
  token: string;
  owner: string;
  repo: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export interface PullRequest {
  number: number;
  url: string;
  draft: boolean;
}

const API = 'https://api.github.com';

/** Issue a request with the required GitHub headers; throw on non-2xx (token never leaked). */
async function request(
  client: GitHubClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${client.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': client.userAgent ?? 'runway',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const fetchImpl = client.fetchImpl ?? fetch;
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

function toPullRequest(pr: { number: number; html_url: string; draft?: boolean }): PullRequest {
  return { number: pr.number, url: pr.html_url, draft: pr.draft ?? false };
}

/** Find the open PR for a head branch, or null. */
export async function findOpenPR(
  client: GitHubClient,
  headBranch: string,
): Promise<PullRequest | null> {
  const head = encodeURIComponent(`${client.owner}:${headBranch}`);
  const pulls = (await request(
    client,
    'GET',
    `/repos/${client.owner}/${client.repo}/pulls?head=${head}&state=open`,
  )) as Array<{ number: number; html_url: string; draft?: boolean }>;
  return pulls.length ? toPullRequest(pulls[0]) : null;
}

/** Create a draft PR, or update the title/body of the existing open one. */
export async function createOrUpdateDraftPR(
  client: GitHubClient,
  args: { head: string; base: string; title: string; body: string },
): Promise<PullRequest> {
  const existing = await findOpenPR(client, args.head);
  if (existing) {
    const updated = (await request(
      client,
      'PATCH',
      `/repos/${client.owner}/${client.repo}/pulls/${existing.number}`,
      { title: args.title, body: args.body },
    )) as { number: number; html_url: string; draft?: boolean };
    return toPullRequest(updated);
  }
  const created = (await request(client, 'POST', `/repos/${client.owner}/${client.repo}/pulls`, {
    title: args.title,
    head: args.head,
    base: args.base,
    body: args.body,
    draft: true,
  })) as { number: number; html_url: string; draft?: boolean };
  return toPullRequest(created);
}

/** Post a comment on an issue or PR (PRs are issues for the comments endpoint). */
export async function postComment(
  client: GitHubClient,
  issueNumber: number,
  body: string,
): Promise<void> {
  await request(
    client,
    'POST',
    `/repos/${client.owner}/${client.repo}/issues/${issueNumber}/comments`,
    { body },
  );
}
