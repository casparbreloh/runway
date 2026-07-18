import type { RepositorySource } from "../source/repository.ts";

const MAX_NAME_LENGTH = 63;

const repositoryNameOf = (source: RepositorySource): string => {
  if (source.authentication.type === "github") return source.authentication.repository.name;
  const pathname = new URL(source.remote).pathname.replace(/\/$/, "");
  const name = pathname.slice(pathname.lastIndexOf("/") + 1).replace(/\.git$/, "");
  if (!name) throw new Error("repository remote has no name");
  return name;
};

const slugOf = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new Error(`invalid repository name ${JSON.stringify(value)}`);
  return slug;
};

export const deploymentNameOf = (source: RepositorySource): string => {
  const repository = slugOf(repositoryNameOf(source));
  const name = repository === "runway" ? "runway" : `runway-${repository}`;
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(`repository name produces a deployment name longer than ${MAX_NAME_LENGTH}`);
  }
  return name;
};
