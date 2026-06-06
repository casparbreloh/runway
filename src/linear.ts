import { parseRepo, type Executor, type JobSpec } from './types';

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Equal-length, byte-for-byte compare. Returns false (not throwing) on length mismatch. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify the hex-encoded HMAC-SHA256 'Linear-Signature' over the raw request body. */
export async function verifyLinearSignature(
  rawBody: ArrayBuffer,
  signature: string,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, rawBody);
  return constantTimeEqual(toHex(mac), signature);
}

/** webhookTimestamp is UNIX milliseconds; true iff within toleranceMs of now. */
export function isFreshTimestamp(webhookTimestamp: number, now = Date.now(), toleranceMs = 60_000): boolean {
  return Math.abs(now - webhookTimestamp) <= toleranceMs;
}

export interface LinearConfig {
  defaultRepo?: string;
  defaultExecutor: Executor;
  defaultBase: string;
  triggerState?: string;
  triggerComment?: string;
}

/** Pick an executor from free text, falling back to the configured default. */
function pickExecutor(text: string, fallback: Executor): Executor {
  const lower = text.toLowerCase();
  if (lower.includes('codex')) return 'codex-cloud';
  if (/\bpi\b/.test(lower)) return 'pi';
  return fallback;
}

/** Resolve "owner/name" from a `repo:` line in the body, else the default. Null if unresolvable. */
function resolveRepo(body: string, defaultRepo: string | undefined): JobSpec['repo'] | null {
  const match = body.match(/^repo:\s*(\S+\/\S+)/im);
  const slug = match ? match[1] : defaultRepo;
  if (!slug) return null;
  try {
    return parseRepo(slug);
  } catch {
    return null;
  }
}

function slugify(basis: string): string {
  return basis.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Convert a Linear webhook payload into a JobSpec, or null when it is not a trigger. */
export function linearEventToJobSpec(payload: any, config: LinearConfig): JobSpec | null {
  const action = payload?.action;
  const type = payload?.type;
  const data = payload?.data ?? {};

  if (type === 'Issue' && (action === 'create' || action === 'update')) {
    if (config.triggerState && data.state?.name !== config.triggerState) return null;

    const description: string = data.description ?? '';
    const repo = resolveRepo(description, config.defaultRepo);
    if (!repo) return null;

    const basis: string = data.identifier ?? data.id ?? '';
    const slug = slugify(basis);
    const executorLine = description.match(/^executor:\s*(\S+)/im)?.[1] ?? '';

    return {
      id: `linear-${slug}`,
      repo,
      branch: `runway/${slug}`,
      plan: [data.title, description].filter(Boolean).join('\n\n'),
      executor: pickExecutor(`${data.title ?? ''} ${executorLine}`, config.defaultExecutor),
      base: config.defaultBase,
      title: data.title,
      source: { type: 'linear', ref: data.identifier },
    };
  }

  if (type === 'Comment' && action === 'create' && config.triggerComment) {
    const body: string = data.body ?? '';
    const trimmed = body.trim();
    if (!trimmed.startsWith(config.triggerComment)) return null;

    const lines = body.split('\n');
    const commandLine = lines[0] ?? '';
    const rest = lines.slice(1).join('\n').trim();
    const plan = rest || body;

    const issueBody: string = data.issue?.description ?? '';
    const repo = resolveRepo(issueBody, config.defaultRepo);
    if (!repo) return null;

    const basis: string = data.issue?.identifier ?? data.issueId ?? data.id ?? '';
    const slug = slugify(basis);

    return {
      id: `linear-${slug}`,
      repo,
      branch: `runway/${slug}`,
      plan,
      executor: pickExecutor(commandLine, config.defaultExecutor),
      base: config.defaultBase,
      title: data.issue?.title,
      source: { type: 'linear', ref: data.issueId },
    };
  }

  return null;
}
