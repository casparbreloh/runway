import type { RepositorySource } from "./repository-source.ts";

export interface WorkflowArtifact {
  readonly scriptName: string;
  readonly workflowId: string;
  readonly secrets: ReadonlyArray<string>;
  readonly repository: RepositorySource;
  readonly source: string;
}

export const workflowArtifactKey = (artifactVersion: string): string =>
  `artifacts/${artifactVersion}.json`;

export const encodeWorkflowArtifact = (artifact: WorkflowArtifact): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(artifact));

export const decodeWorkflowArtifact = (bytes: ArrayBuffer): WorkflowArtifact => {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("invalid workflow artifact");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "repository,scriptName,secrets,source,workflowId"
  ) {
    throw new Error("invalid workflow artifact");
  }
  const { scriptName, workflowId, secrets, repository, source } = value as Record<string, unknown>;
  if (
    typeof scriptName !== "string" ||
    scriptName.length === 0 ||
    typeof workflowId !== "string" ||
    workflowId.length === 0 ||
    !Array.isArray(secrets) ||
    secrets.some((name) => typeof name !== "string") ||
    new Set(secrets).size !== secrets.length ||
    !repository ||
    typeof repository !== "object" ||
    Array.isArray(repository) ||
    Object.keys(repository).sort().join(",") !== "authentication,commit,remote" ||
    typeof source !== "string"
  ) {
    throw new Error("invalid workflow artifact");
  }
  const { remote, commit, authentication } = repository as Record<string, unknown>;
  if (
    typeof remote !== "string" ||
    remote.length === 0 ||
    typeof commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    !authentication ||
    typeof authentication !== "object" ||
    Array.isArray(authentication) ||
    Object.keys(authentication).join(",") !== "type" ||
    (authentication as Record<string, unknown>).type !== "public"
  ) {
    throw new Error("invalid workflow artifact");
  }
  return { scriptName, workflowId, secrets, repository, source } as WorkflowArtifact;
};
