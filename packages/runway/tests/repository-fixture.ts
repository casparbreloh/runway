import type { RepositorySource } from "../src/internal/source/repository.ts";

export const repositoryFixture: RepositorySource = {
  remote: "https://github.com/casparbreloh/runway.git",
  commit: "1328fb0d0e8629a84abc11d820715cb5c78b629c",
  authentication: { type: "public" },
};

export const authenticatedRepositoryFixture: RepositorySource = {
  remote: "https://github.com/casparbreloh/runway",
  commit: "2328fb0d0e8629a84abc11d820715cb5c78b629c",
  authentication: {
    type: "github",
    installationId: 42,
    repository: {
      id: 101,
      name: "runway",
      fullName: "casparbreloh/runway",
    },
  },
};
