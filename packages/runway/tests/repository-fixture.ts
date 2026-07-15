import type { RepositorySource } from "../src/repository-source.ts";

export const repositoryFixture: RepositorySource = {
  remote: "https://github.com/casparbreloh/runway.git",
  commit: "1328fb0d0e8629a84abc11d820715cb5c78b629c",
  authentication: { type: "public" },
};
