import { getSandbox, proxyToSandbox } from '@cloudflare/sandbox';
import { CloudflareSandboxRunner, type SandboxRunner } from './sandbox';
import {
  isFreshTimestamp,
  linearEventToJobSpec,
  verifyLinearSignature,
  type LinearConfig,
} from './linear';
import { createOrUpdateDraftPR, postComment, type GitHubClient } from './github';
import { runCodexCloud } from './executors/codex-cloud';
import { runPi } from './executors/pi';
import { parseRepo, type Env, type Executor, type JobResult, type JobSpec } from './types';

// Re-export the Durable Object class so wrangler can bind it (containers/durable_objects/migrations).
export { Sandbox } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Serve Sandbox container preview URLs first (required by the SDK).
    const proxied = await proxyToSandbox(request, env);
    if (proxied) return proxied;

    const { pathname } = new URL(request.url);

    if (request.method === 'GET' && pathname === '/health') {
      return Response.json({ ok: true });
    }
    if (request.method === 'POST' && pathname === '/webhooks/linear') {
      return handleLinearWebhook(request, env, ctx);
    }
    if (request.method === 'POST' && pathname === '/jobs') {
      return handleJobSubmit(request, env, ctx);
    }
    const jobMatch = pathname.match(/^\/jobs\/([^/]+)$/);
    if (request.method === 'GET' && jobMatch) {
      const job = await readJob(env, jobMatch[1]);
      return job ? Response.json(job) : new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// --- Webhook + job intake -------------------------------------------------

async function handleLinearWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.LINEAR_WEBHOOK_SECRET) return new Response('linear webhook not configured', { status: 503 });

  // Verify the HMAC over the RAW body before parsing.
  const raw = await request.arrayBuffer();
  const signature = request.headers.get('Linear-Signature') ?? '';
  if (!(await verifyLinearSignature(raw, signature, env.LINEAR_WEBHOOK_SECRET))) {
    return new Response('bad signature', { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response('bad json', { status: 400 });
  }
  // Replay protection is mandatory: a verified body that omits a numeric timestamp must be rejected,
  // otherwise a captured (body, signature) pair replays forever.
  const ts = payload.webhookTimestamp;
  if (typeof ts !== 'number' || !isFreshTimestamp(ts)) {
    return new Response('stale or missing timestamp', { status: 401 });
  }

  const spec = linearEventToJobSpec(payload, linearConfig(env));
  if (!spec) return new Response('ignored (not a trigger)', { status: 202 });

  ctx.waitUntil(dispatchJob(spec, env));
  return Response.json({ accepted: true, jobId: spec.id }, { status: 202 });
}

async function handleJobSubmit(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!authorizeJob(request, env)) return new Response('unauthorized', { status: 401 });
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }
  let spec: JobSpec;
  try {
    spec = normalizeJobSpec(body, env);
  } catch (err) {
    return new Response(errMessage(err), { status: 400 });
  }
  ctx.waitUntil(dispatchJob(spec, env));
  return Response.json({ accepted: true, jobId: spec.id }, { status: 202 });
}

/** Build a JobSpec from a loose body (the markdown/dev path), applying env defaults. */
function normalizeJobSpec(body: any, env: Env): JobSpec {
  const plan = typeof body?.plan === 'string' ? body.plan : '';
  if (!plan.trim()) throw new Error('plan is required');

  const repoInput = body?.repo ?? env.DEFAULT_REPO;
  if (!repoInput) throw new Error('repo is required (body.repo "owner/name" or DEFAULT_REPO)');
  // Always validate through parseRepo (charset guard), whether a string or an {owner,name} object.
  const repo = parseRepo(typeof repoInput === 'string' ? repoInput : `${repoInput.owner}/${repoInput.name}`);

  const executor = (body?.executor ?? env.DEFAULT_EXECUTOR ?? 'pi') as Executor;
  if (executor !== 'pi' && executor !== 'codex-cloud') throw new Error(`unknown executor "${executor}"`);

  const id = String(body?.id ?? crypto.randomUUID()).toLowerCase();
  const branch = body?.branch ?? `runway/${id}`;
  // branch is interpolated into git shell commands — keep it to a safe charset.
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-')) {
    throw new Error('invalid branch (allowed: letters, digits, . _ / -, no leading "-")');
  }
  return {
    id,
    repo,
    branch,
    plan,
    executor,
    base: body?.base ?? env.DEFAULT_BASE ?? 'main',
    validate: Array.isArray(body?.validate) ? body.validate : undefined,
    title: body?.title,
    source: body?.source ?? { type: 'markdown' },
  };
}

// --- Dispatch -------------------------------------------------------------

async function dispatchJob(spec: JobSpec, env: Env): Promise<JobResult> {
  await writeJob(env, { jobId: spec.id, executor: spec.executor, status: 'running' });

  let result: JobResult;
  try {
    const runner = createRunner(env, spec.id);
    if (spec.executor === 'codex-cloud') {
      result = await runCodexCloud(spec, runner, {
        envId: env.CODEX_CLOUD_ENV_ID ?? '',
        accessToken: env.CODEX_ACCESS_TOKEN,
      });
    } else {
      result = await runPi(spec, runner, {
        githubToken: env.GITHUB_TOKEN ?? '',
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        openaiApiKey: env.OPENAI_API_KEY,
      });
      // pi pushed a branch with changes; the Worker (control plane) opens/updates the draft PR.
      // A PR failure must not discard the fact that the branch is already on origin.
      if (result.status === 'success' && result.pushed && env.GITHUB_TOKEN) {
        try {
          result = { ...result, ...(await openDraftPr(env, spec, result)) };
        } catch (prErr) {
          result = {
            ...result,
            error: `branch ${spec.branch} pushed but PR creation failed: ${errMessage(prErr)}`,
            summary: `Branch ${spec.branch} pushed; draft PR creation failed — open it manually.`,
          };
        }
      }
    }
  } catch (err) {
    result = { jobId: spec.id, executor: spec.executor, status: 'failure', error: errMessage(err) };
  }

  await writeJob(env, result);
  return result;
}

function createRunner(env: Env, jobId: string): SandboxRunner {
  // Sandbox ids must be lowercase (preview-URL hostnames are case-insensitive).
  return new CloudflareSandboxRunner(getSandbox(env.Sandbox, jobId.toLowerCase()));
}

async function openDraftPr(env: Env, spec: JobSpec, result: JobResult): Promise<Partial<JobResult>> {
  const client: GitHubClient = {
    token: env.GITHUB_TOKEN!,
    owner: spec.repo.owner,
    repo: spec.repo.name,
    userAgent: 'runway',
  };
  const title = spec.title ?? `Runway: ${spec.branch}`;
  const pr = await createOrUpdateDraftPR(client, {
    head: spec.branch,
    base: spec.base,
    title,
    body: prBody(spec, result),
  });
  await postComment(client, pr.number, prComment(result));
  return {
    status: 'success',
    prUrl: pr.url,
    prNumber: pr.number,
    summary: `Draft PR #${pr.number} ready: ${pr.url}`,
  };
}

// --- Job state (best-effort; KV is optional) ------------------------------

async function writeJob(env: Env, result: JobResult): Promise<void> {
  if (!env.JOBS) return;
  try {
    await env.JOBS.put(`job:${result.jobId}`, JSON.stringify(result), {
      expirationTtl: 60 * 60 * 24 * 7,
    });
  } catch {
    // best-effort: never fail a job because state couldn't be persisted
  }
}

async function readJob(env: Env, id: string): Promise<JobResult | null> {
  if (!env.JOBS) return null;
  const raw = await env.JOBS.get(`job:${id.toLowerCase()}`);
  return raw ? (JSON.parse(raw) as JobResult) : null;
}

// --- Helpers --------------------------------------------------------------

function linearConfig(env: Env): LinearConfig {
  return {
    defaultRepo: env.DEFAULT_REPO || undefined,
    defaultExecutor: (env.DEFAULT_EXECUTOR as Executor) || 'pi',
    defaultBase: env.DEFAULT_BASE || 'main',
    triggerState: env.LINEAR_TRIGGER_STATE || undefined,
    triggerComment: env.LINEAR_TRIGGER_COMMENT || undefined,
  };
}

function prBody(spec: JobSpec, result: JobResult): string {
  const validation =
    result.validated === undefined ? '_no validation commands_' : result.validated ? '✅ passed' : '❌ failed';
  return [
    `Automated draft PR opened by **Runway** (executor: \`${spec.executor}\`).`,
    '',
    `**Validation:** ${validation}`,
    spec.source?.ref ? `**Source:** ${spec.source.type} \`${spec.source.ref}\`` : '',
    '',
    '<details><summary>Plan</summary>',
    '',
    '```',
    spec.plan,
    '```',
    '',
    '</details>',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

function prComment(result: JobResult): string {
  return result.summary ?? `Runway job ${result.jobId}: ${result.status}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Constant-time string compare (avoids leaking the match length via timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Authorize POST /jobs via a bearer token. Fail closed: no RUNWAY_API_TOKEN configured => denied. */
function authorizeJob(request: Request, env: Env): boolean {
  if (!env.RUNWAY_API_TOKEN) return false;
  const header = request.headers.get('Authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  return presented.length > 0 && timingSafeEqual(presented, env.RUNWAY_API_TOKEN);
}
