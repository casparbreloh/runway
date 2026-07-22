import type { GitHubRepository } from "../../trigger.ts";

const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

const isPositiveGitHubId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const githubRepositoryName = (
  fullName: unknown,
): { readonly owner: string; readonly name: string } | undefined => {
  if (typeof fullName !== "string") return undefined;
  const parts = fullName.split("/");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !REPOSITORY_PART.test(parts[0]) ||
    !REPOSITORY_PART.test(parts[1])
  ) {
    return undefined;
  }
  return { owner: parts[0], name: parts[1] };
};

export const validGitHubRepository = (value: {
  readonly id: unknown;
  readonly name: unknown;
  readonly fullName: unknown;
}): value is GitHubRepository => {
  const parsed = githubRepositoryName(value.fullName);
  return (
    isPositiveGitHubId(value.id) && typeof value.name === "string" && parsed?.name === value.name
  );
};
