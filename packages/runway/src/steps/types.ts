// Argument + result types for the Runway step primitives. Handles are plain serializable
// data (never live stubs) so they survive being passed between durable Workflow steps.

// --- sandbox --------------------------------------------------------------
export interface SandboxArgs {
  // Stable id for the container. Defaults to one derived from the workflow instance, so
  // every step in a run shares one sandbox and re-runs reuse it.
  readonly id?: string;
}
export interface SandboxHandle {
  readonly id: string;
}

// --- shell ----------------------------------------------------------------
export interface ShellArgs {
  readonly sandbox: SandboxHandle;
  readonly cmd: string;
  readonly cwd?: string;
  // Per-command environment — the safe channel for secrets (they never reach argv).
  readonly env?: Record<string, string>;
}
export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// --- agent ----------------------------------------------------------------
export interface AgentArgs {
  readonly sandbox: SandboxHandle;
  readonly prompt: string;
  // API key for the agent's model (e.g. an Anthropic key). Passed via env, not argv.
  readonly apiKey: string;
  readonly cwd?: string;
  readonly model?: string;
}
export interface AgentResult {
  readonly summary: string;
}

// --- http -----------------------------------------------------------------
// A JSON value — serializable, so it can be returned from a durable step.do. The object and
// array branches are interfaces so the type evaluates lazily (avoids deep-instantiation
// blowups when Cloudflare's Serializable<> maps over it).
export type Json = null | boolean | number | string | JsonObject | JsonArray;
export interface JsonObject {
  readonly [key: string]: Json;
}
export interface JsonArray extends ReadonlyArray<Json> {}

export interface HttpArgs {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly body?: string;
}
export interface HttpResult {
  readonly status: number;
  readonly ok: boolean;
  readonly json: Json;
  readonly text: string;
}
