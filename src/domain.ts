// Runway domain: Effect Schema for the data crossing boundaries + tagged errors for the typed E channel.
import { Data, Schema } from "effect";

// ── Job ───────────────────────────────────────────────────────────────────
export const Executor = Schema.Literals(["codex-cloud", "pi"]);
export type Executor = typeof Executor.Type;

export const Repo = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
});
export type Repo = typeof Repo.Type;

export const JobSource = Schema.Struct({
  type: Schema.Literals(["linear", "markdown", "api"]),
  ref: Schema.optional(Schema.String),
});

/** The minimal unit of work. */
export const JobSpec = Schema.Struct({
  id: Schema.String, // lowercase; also the sandbox/job key
  repo: Repo,
  branch: Schema.String,
  plan: Schema.String,
  executor: Executor,
  base: Schema.String, // PR base, default "main"
  validate: Schema.optional(Schema.Array(Schema.String)),
  title: Schema.optional(Schema.String),
  source: Schema.optional(JobSource),
});
export type JobSpec = typeof JobSpec.Type;

export const JobStatus = Schema.Literals(["queued", "running", "submitted", "success", "failure"]);
export type JobStatus = typeof JobStatus.Type;

export const JobResult = Schema.Struct({
  jobId: Schema.String,
  executor: Executor,
  status: JobStatus,
  taskUrl: Schema.optional(Schema.String), // codex-cloud
  taskId: Schema.optional(Schema.String),
  prUrl: Schema.optional(Schema.String), // pi
  prNumber: Schema.optional(Schema.Number),
  pushed: Schema.optional(Schema.Boolean),
  validated: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  logsTail: Schema.optional(Schema.String),
});
export type JobResult = typeof JobResult.Type;

// ── Linear webhook payloads (only the fields Runway reads) ──────────────────
export const LinearIssueData = Schema.Struct({
  id: Schema.String,
  identifier: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String), type: Schema.optional(Schema.String) })),
});

export const LinearCommentData = Schema.Struct({
  id: Schema.String,
  body: Schema.optional(Schema.String),
  issueId: Schema.optional(Schema.String),
  issue: Schema.optional(
    Schema.Struct({
      identifier: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
    }),
  ),
});

/** Top-level webhook envelope; `data` is left loose and decoded per `type` downstream. */
export const LinearWebhook = Schema.Struct({
  action: Schema.Literals(["create", "update", "remove"]),
  type: Schema.String,
  webhookTimestamp: Schema.Number,
  data: Schema.Record(Schema.String, Schema.Unknown),
});
export type LinearWebhook = typeof LinearWebhook.Type;

// ── GitHub (minimal PR shape we consume) ────────────────────────────────────
export const PullRequest = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  draft: Schema.optional(Schema.Boolean),
});
export type PullRequest = typeof PullRequest.Type;

// ── Tagged errors (the typed E channel) ─────────────────────────────────────
export class ValidationError extends Data.TaggedError("ValidationError")<{ readonly reason: string }> {}
export class WebhookError extends Data.TaggedError("WebhookError")<{ readonly reason: string }> {}
export class AuthError extends Data.TaggedError("AuthError")<{ readonly reason: string }> {}
export class SandboxError extends Data.TaggedError("SandboxError")<{ readonly reason: string }> {}
export class ExecError extends Data.TaggedError("ExecError")<{
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {}
export class GitHubError extends Data.TaggedError("GitHubError")<{
  readonly status: number;
  readonly message: string;
}> {}
export class MissingConfigError extends Data.TaggedError("MissingConfigError")<{ readonly key: string }> {}

// ── Helpers ─────────────────────────────────────────────────────────────────
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Parse "owner/name", rejecting shell metacharacters (these flow into git commands). */
export const parseRepo = (slug: string): Repo => {
  const [owner, name, ...rest] = slug.trim().split("/");
  if (!owner || !name || rest.length) throw new Error(`invalid repo "${slug}", expected "owner/name"`);
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(name)) {
    throw new Error(`invalid repo "${slug}": owner/name may contain only letters, digits, '.', '_', '-'`);
  }
  return { owner, name };
};
