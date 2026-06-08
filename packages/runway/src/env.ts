import type { Sandbox } from "@cloudflare/sandbox";

// The baseline binding every Runway worker needs: the coding Sandbox (a Container-backed
// Durable Object). Your app augments this same global `Env` with its own workflow bindings
// and secrets (see the app's env.d.ts), and `wrangler types` would generate the rest.
declare global {
  interface Env {
    readonly Sandbox: DurableObjectNamespace<Sandbox>;
  }
}

export {};
