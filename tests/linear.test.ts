import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  isFreshTimestamp,
  linearEventToJobSpec,
  verifyLinearSignature,
  type LinearConfig,
} from '../src/linear';

const SECRET = 'whsec_test';

function signedSignature(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyLinearSignature', () => {
  it('returns true for a correct signature', async () => {
    const body = JSON.stringify({ action: 'create', type: 'Issue' });
    const sig = signedSignature(body, SECRET);
    const rawBody = new TextEncoder().encode(body).buffer as ArrayBuffer;
    expect(await verifyLinearSignature(rawBody, sig, SECRET)).toBe(true);
  });

  it('returns false for a wrong (same-length) signature', async () => {
    const body = 'hello';
    const sig = signedSignature(body, SECRET);
    const wrong = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
    const rawBody = new TextEncoder().encode(body).buffer as ArrayBuffer;
    expect(await verifyLinearSignature(rawBody, wrong, SECRET)).toBe(false);
  });

  it('returns false on length mismatch', async () => {
    const body = 'hello';
    const rawBody = new TextEncoder().encode(body).buffer as ArrayBuffer;
    expect(await verifyLinearSignature(rawBody, 'abc123', SECRET)).toBe(false);
  });
});

describe('isFreshTimestamp', () => {
  it('is true within tolerance', () => {
    const now = 1_000_000;
    expect(isFreshTimestamp(now - 30_000, now)).toBe(true);
  });

  it('is false outside tolerance', () => {
    const now = 1_000_000;
    expect(isFreshTimestamp(now - 120_000, now)).toBe(false);
  });
});

describe('linearEventToJobSpec', () => {
  const config: LinearConfig = {
    defaultExecutor: 'pi',
    defaultBase: 'main',
    triggerState: 'Ready',
    triggerComment: '/runway',
  };

  it('maps an Issue in the trigger state with a repo line', () => {
    const payload = {
      action: 'update',
      type: 'Issue',
      data: {
        id: 'uuid-1',
        identifier: 'ENG-123',
        title: 'Add feature',
        description: 'Do the thing.\nrepo: acme/widgets\nexecutor: codex',
        state: { name: 'Ready', type: 'started' },
      },
      webhookTimestamp: Date.now(),
    };

    const spec = linearEventToJobSpec(payload, config);
    expect(spec).not.toBeNull();
    expect(spec!.repo).toEqual({ owner: 'acme', name: 'widgets' });
    expect(spec!.branch).toBe('runway/eng-123');
    expect(spec!.id).toBe('linear-eng-123');
    expect(spec!.executor).toBe('codex-cloud');
    expect(spec!.plan).toContain('Add feature');
    expect(spec!.plan).toContain('repo: acme/widgets');
    expect(spec!.source).toEqual({ type: 'linear', ref: 'ENG-123' });
    expect(spec!.base).toBe('main');
  });

  it('returns null for an Issue in the wrong state', () => {
    const payload = {
      action: 'update',
      type: 'Issue',
      data: {
        id: 'uuid-2',
        identifier: 'ENG-124',
        title: 'Not ready',
        description: 'repo: acme/widgets',
        state: { name: 'Backlog', type: 'backlog' },
      },
      webhookTimestamp: Date.now(),
    };
    expect(linearEventToJobSpec(payload, config)).toBeNull();
  });

  it('maps a "/runway codex" comment to executor codex-cloud', () => {
    const payload = {
      action: 'create',
      type: 'Comment',
      data: {
        id: 'comment-1',
        body: '/runway codex\nplease implement the parser',
        issueId: 'issue-uuid-9',
        issue: { identifier: 'ENG-200', title: 'Parser', description: 'repo: acme/widgets' },
      },
      webhookTimestamp: Date.now(),
    };

    const spec = linearEventToJobSpec(payload, config);
    expect(spec).not.toBeNull();
    expect(spec!.executor).toBe('codex-cloud');
    expect(spec!.plan).toBe('please implement the parser');
    expect(spec!.source).toEqual({ type: 'linear', ref: 'issue-uuid-9' });
    expect(spec!.repo).toEqual({ owner: 'acme', name: 'widgets' });
  });
});
