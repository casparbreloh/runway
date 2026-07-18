import { parseRepositorySource } from "./internal/source/repository.ts";
import type { RepositorySource } from "./internal/source/repository.ts";

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
    typeof source !== "string"
  ) {
    throw new Error("invalid workflow artifact");
  }
  let parsedRepository: RepositorySource;
  try {
    parsedRepository = parseRepositorySource(repository);
  } catch {
    throw new Error("invalid workflow artifact");
  }
  return { scriptName, workflowId, secrets, repository: parsedRepository, source };
};
