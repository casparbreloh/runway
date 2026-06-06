import { Data, Schema } from "effect";

export const AgentName = Schema.Literals(["codex", "pi"]);
export type AgentName = typeof AgentName.Type;

export const SourceName = Schema.Literals(["linear", "markdown"]);
export type SourceName = typeof SourceName.Type;

export const Repo = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
});
export type Repo = typeof Repo.Type;

export const JobSource = Schema.Struct({
  type: SourceName,
  ref: Schema.optional(Schema.String),
});

export const JobSpec = Schema.Struct({
  id: Schema.String,
  repo: Repo,
  branch: Schema.String,
  plan: Schema.String,
  agent: AgentName,
  base: Schema.String,
  validate: Schema.optional(Schema.Array(Schema.String)),
  title: Schema.optional(Schema.String),
  source: Schema.optional(JobSource),
});
export type JobSpec = typeof JobSpec.Type;

export const JobStatus = Schema.Literals(["queued", "running", "submitted", "success", "failure"]);
export type JobStatus = typeof JobStatus.Type;

export const JobResult = Schema.Struct({
  jobId: Schema.String,
  agent: AgentName,
  status: JobStatus,
  taskUrl: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  prUrl: Schema.optional(Schema.String),
  prNumber: Schema.optional(Schema.Number),
  pushed: Schema.optional(Schema.Boolean),
  validated: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  logsTail: Schema.optional(Schema.String),
});
export type JobResult = typeof JobResult.Type;

export const LinearIssueData = Schema.Struct({
  id: Schema.String,
  identifier: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  state: Schema.optional(
    Schema.Struct({ name: Schema.optional(Schema.String), type: Schema.optional(Schema.String) }),
  ),
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

export const LinearWebhook = Schema.Struct({
  action: Schema.Literals(["create", "update", "remove"]),
  type: Schema.String,
  webhookTimestamp: Schema.Number,
  data: Schema.Record(Schema.String, Schema.Unknown),
});
export type LinearWebhook = typeof LinearWebhook.Type;

export const PullRequest = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  draft: Schema.optional(Schema.Boolean),
});
export type PullRequest = typeof PullRequest.Type;

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly reason: string;
}> {}
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
export class StoreError extends Data.TaggedError("StoreError")<{ readonly reason: string }> {}

const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

export const parseRepo = (slug: string): Repo => {
  const [owner, name, ...rest] = slug.trim().split("/");
  if (!owner || !name || rest.length)
    throw new Error(`invalid repo "${slug}", expected "owner/name"`);
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(name)) {
    throw new Error(
      `invalid repo "${slug}": owner/name may contain only letters, digits, '.', '_', '-'`,
    );
  }
  return { owner, name };
};

export const jobResult = (
  spec: JobSpec,
  status: JobStatus,
  extra?: Partial<JobResult>,
): JobResult => ({
  jobId: spec.id,
  agent: spec.agent,
  status,
  ...extra,
});
