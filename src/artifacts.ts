// Cloudflare Artifacts (https://developers.cloudflare.com/artifacts) — "git for agents",
// announced Agents Week 2026, currently beta. @cloudflare/workers-types does not ship the
// binding type yet, so we hand-declare the slice we use from the documented API. When the
// official types land, delete this and import them.

export interface ArtifactsRepoRef {
  // Git smart-HTTP remote, e.g. https://<account>.artifacts.cloudflare.net/git/<ns>/<repo>.git
  readonly remote: string;
  // Bearer token scoped to the repo; a write token is needed to push.
  readonly token: string;
  readonly defaultBranch: string;
}

export interface ArtifactsRepo {
  // Fork this repo into a new, independently-diverging repo (the "fork the artifact" op).
  fork(
    name: string,
    opts?: { readOnly?: boolean; description?: string },
  ): Promise<ArtifactsRepoRef>;
  createToken(scope?: "read" | "write", ttl?: number): Promise<{ token: string }>;
}

export interface Artifacts {
  create(
    name: string,
    opts?: { readOnly?: boolean; description?: string },
  ): Promise<ArtifactsRepoRef>;
  get(name: string): Promise<ArtifactsRepo>;
  list(): Promise<{ repos: ReadonlyArray<string> }>;
  // Bootstrap a repo from an existing remote (e.g. github.com) so an agent can work on it.
  import(args: {
    source: { url: string; branch?: string; depth?: number };
    target: { name: string };
  }): Promise<ArtifactsRepoRef>;
  delete(name: string): Promise<boolean>;
}
