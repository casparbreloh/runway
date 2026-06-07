// Argument + result types for the Runway step primitives. These are the contract the
// `run*` implementations in this folder satisfy and that step.ts wires onto the workflow
// `step`. Handles are plain serializable data (never live stubs) so they survive being
// passed between durable Cloudflare Workflow steps.

// --- artifact -------------------------------------------------------------
export interface ArtifactForkArgs {
  // GitHub repo to base the artifact on, "owner/repo".
  readonly from: string;
  // Session discriminator (e.g. a Linear identifier) — keeps each run's fork isolated.
  readonly as: string;
}
export interface ArtifactHandle {
  readonly name: string;
  readonly remote: string;
  readonly token: string;
}

// --- sandbox --------------------------------------------------------------
export interface SandboxArgs {
  // Clone source: an artifact fork, or a GitHub "owner/repo".
  readonly from: ArtifactHandle | string;
  readonly branch: string;
  readonly base?: string;
}
export interface SandboxHandle {
  readonly id: string;
  readonly dir: string;
  readonly branch: string;
  readonly base: string;
}

// --- agent ----------------------------------------------------------------
export interface AgentArgs {
  readonly sandbox: SandboxHandle;
  readonly prompt: string;
  // Defaults to an API-key model; overridable per call.
  readonly model?: string;
  // Optional commands run after the agent to gate the result (non-zero = not validated).
  readonly validate?: ReadonlyArray<string>;
}
export interface AgentResult {
  readonly summary: string;
  readonly changed: boolean;
  readonly validated?: boolean;
}

// --- git.pr ---------------------------------------------------------------
export interface GitPrArgs {
  readonly sandbox: SandboxHandle;
  // GitHub repo the PR opens against, "owner/repo".
  readonly repo: string;
  readonly title: string;
  readonly body?: string;
  readonly draft?: boolean;
}
export interface PrResult {
  readonly pushed: boolean;
  readonly url?: string;
  readonly number?: number;
}

// --- http -----------------------------------------------------------------
// A JSON value — serializable, so it can be returned from a durable step.do. The object and
// array branches are interfaces so the type is evaluated lazily (avoids deep-instantiation
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
