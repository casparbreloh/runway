declare global {
  interface Env {
    readonly LINEAR_TO_PR: Workflow;
    readonly GITHUB_TOKEN: string;
    readonly ANTHROPIC_API_KEY: string;
    readonly LINEAR_TOKEN: string;
    readonly LINEAR_SIGNING_SECRET: string;
  }
}

export {};
