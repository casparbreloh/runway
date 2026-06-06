import type { Sandbox } from '@cloudflare/sandbox';

/** The two V1 execution modes. */
export type Executor = 'codex-cloud' | 'pi';

/** Where a job came from (provenance only; does not affect execution). */
export interface JobSource {
  type: 'linear' | 'markdown' | 'api';
  /** Linear issue identifier (e.g. "ENG-123") or a file path. */
  ref?: string;
}

/** The minimal unit of work. Only fields needed for repo, branch, plan, executor, PR target. */
export interface JobSpec {
  /** Stable job id (also used as the sandbox id). Lowercase. */
  id: string;
  /** Target GitHub repo. */
  repo: { owner: string; name: string };
  /** Working branch the agent commits to. */
  branch: string;
  /** Plan / prompt text the executor runs. */
  plan: string;
  executor: Executor;
  /** PR base branch (pi mode). Defaults to "main". */
  base: string;
  /** Validation commands to run after the agent (pi mode). */
  validate?: string[];
  /** Human title for the PR / task. */
  title?: string;
  source?: JobSource;
}

export type JobStatus = 'queued' | 'running' | 'submitted' | 'success' | 'failure';

/** Result of running an executor. */
export interface JobResult {
  jobId: string;
  executor: Executor;
  status: JobStatus;
  /** codex-cloud: the Codex Cloud task URL/ID. */
  taskUrl?: string;
  taskId?: string;
  /** pi: the draft PR opened/updated. */
  prUrl?: string;
  prNumber?: number;
  /** pi: whether a branch with real changes was pushed (gates PR creation). */
  pushed?: boolean;
  /** Whether validation commands passed (pi mode). */
  validated?: boolean;
  /** Short human summary of the outcome. */
  summary?: string;
  /** Failure detail (no secrets). */
  error?: string;
  /** Tail of relevant logs for debugging (no secrets). */
  logsTail?: string;
}

/** Worker bindings + config. Secrets are optional so local/dev paths degrade gracefully. */
export interface Env {
  /** Cloudflare Sandbox Durable Object binding. */
  Sandbox: DurableObjectNamespace<Sandbox>;
  /** Optional best-effort job-state store. */
  JOBS?: KVNamespace;

  // config (non-secret)
  DEFAULT_EXECUTOR?: string;
  DEFAULT_REPO?: string;
  DEFAULT_BASE?: string;
  GITHUB_OWNER?: string;
  CODEX_CLOUD_ENV_ID?: string;
  LINEAR_TRIGGER_STATE?: string;
  LINEAR_TRIGGER_COMMENT?: string;

  // secrets
  LINEAR_WEBHOOK_SECRET?: string;
  /** Bearer token required to call POST /jobs. Unset = endpoint disabled (fail closed). */
  RUNWAY_API_TOKEN?: string;
  GITHUB_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CODEX_ACCESS_TOKEN?: string;
}

// GitHub owner/repo grammar — also our injection guard, since owner/name flow into shell commands.
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Parse "owner/name" into a repo object. Throws on malformed or unsafe input. */
export function parseRepo(slug: string): { owner: string; name: string } {
  const [owner, name, ...rest] = slug.trim().split('/');
  if (!owner || !name || rest.length) throw new Error(`invalid repo "${slug}", expected "owner/name"`);
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(name)) {
    throw new Error(`invalid repo "${slug}": owner/name may contain only letters, digits, '.', '_', '-'`);
  }
  return { owner, name };
}
