import { Data, Schema } from "effect";

export const AgentName = Schema.Literals(["codex", "pi"]);
export type AgentName = typeof AgentName.Type;

export const Repo = Schema.Struct({
  owner: Schema.String,
  name: Schema.String,
});
export type Repo = typeof Repo.Type;

export const JobSpec = Schema.Struct({
  id: Schema.String,
  repo: Repo,
  branch: Schema.String,
  plan: Schema.String,
  agent: AgentName,
  base: Schema.String,
  validate: Schema.optional(Schema.Array(Schema.String)),
  title: Schema.optional(Schema.String),
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
