import type { Sandbox } from "@cloudflare/sandbox";

declare global {
  interface Env {
    readonly Sandbox: DurableObjectNamespace<Sandbox>;
  }
}

export {};
