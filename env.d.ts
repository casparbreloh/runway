// App bindings + secrets, augmenting the global `Env` that `runway` declares. In a real
// project `wrangler types` generates this from wrangler.jsonc; secrets are set with
// `wrangler secret put` and read as plain `env.*` — there is no separate vault.
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
