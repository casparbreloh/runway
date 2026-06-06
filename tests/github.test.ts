import { describe, it, expect } from 'vitest';
import {
  createOrUpdateDraftPR,
  postComment,
  type GitHubClient,
} from '../src/github';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Build a mock fetchImpl that records each request and replies with the queued Responses. */
function mockFetch(responses: Response[]) {
  const requests: RecordedRequest[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return responses[i++];
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function client(fetchImpl: typeof fetch): GitHubClient {
  return { token: 'secret-token', owner: 'acme', repo: 'widget', userAgent: 'runway', fetchImpl };
}

describe('createOrUpdateDraftPR', () => {
  it('creates a draft PR when none is open', async () => {
    const { fetchImpl, requests } = mockFetch([
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(
        JSON.stringify({ number: 42, html_url: 'https://github.com/acme/widget/pull/42', draft: true }),
        { status: 201 },
      ),
    ]);

    const pr = await createOrUpdateDraftPR(client(fetchImpl), {
      head: 'feature-x',
      base: 'main',
      title: 'Add feature x',
      body: 'does the thing',
    });

    expect(pr).toEqual({ number: 42, url: 'https://github.com/acme/widget/pull/42', draft: true });

    const post = requests[1];
    expect(post.method).toBe('POST');
    expect(post.url).toBe('https://api.github.com/repos/acme/widget/pulls');
    expect(post.body).toEqual({
      title: 'Add feature x',
      head: 'feature-x',
      base: 'main',
      body: 'does the thing',
      draft: true,
    });
  });

  it('updates the open PR via PATCH (no draft field)', async () => {
    const { fetchImpl, requests } = mockFetch([
      new Response(
        JSON.stringify([
          { number: 7, html_url: 'https://github.com/acme/widget/pull/7', draft: true },
        ]),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({ number: 7, html_url: 'https://github.com/acme/widget/pull/7', draft: true }),
        { status: 200 },
      ),
    ]);

    const pr = await createOrUpdateDraftPR(client(fetchImpl), {
      head: 'feature-x',
      base: 'main',
      title: 'Updated title',
      body: 'updated body',
    });

    expect(pr).toEqual({ number: 7, url: 'https://github.com/acme/widget/pull/7', draft: true });

    const patch = requests[1];
    expect(patch.method).toBe('PATCH');
    expect(patch.url).toBe('https://api.github.com/repos/acme/widget/pulls/7');
    expect(patch.body).toEqual({ title: 'Updated title', body: 'updated body' });
    expect(patch.body).not.toHaveProperty('draft');
  });

  it('sends the required headers on every request', async () => {
    const { fetchImpl, requests } = mockFetch([
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(
        JSON.stringify({ number: 1, html_url: 'https://github.com/acme/widget/pull/1', draft: true }),
        { status: 201 },
      ),
    ]);

    await createOrUpdateDraftPR(client(fetchImpl), {
      head: 'b',
      base: 'main',
      title: 't',
      body: 'b',
    });

    for (const req of requests) {
      expect(req.headers['Authorization']).toBe('Bearer secret-token');
      expect(req.headers['Accept']).toBe('application/vnd.github+json');
      expect(req.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
      expect(req.headers['User-Agent']).toBe('runway');
    }
  });
});

describe('postComment', () => {
  it('posts to the issues comments endpoint', async () => {
    const { fetchImpl, requests } = mockFetch([new Response(JSON.stringify({ id: 1 }), { status: 201 })]);

    await postComment(client(fetchImpl), 99, 'validation passed');

    const post = requests[0];
    expect(post.method).toBe('POST');
    expect(post.url).toBe('https://api.github.com/repos/acme/widget/issues/99/comments');
    expect(post.body).toEqual({ body: 'validation passed' });
  });
});
