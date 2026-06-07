import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

import type { Env } from "../env.ts";

// Re-acquire a sandbox by its stable id. The DO stub is NOT serializable across durable
// step boundaries, so every step that touches the sandbox resolves it fresh from the id.
export const sandboxFor = (env: Env, id: string): Sandbox => getSandbox(env.Sandbox, id);

const REDACT_TOKEN = /x-access-token:[^@\s]+@/g;
export const tail = (s: string): string => (s.length > 2000 ? s.slice(-2000) : s);
export const redact = (s: string): string => tail(s).replace(REDACT_TOKEN, "x-access-token:***@");

// Only allow shell-safe refs so we can interpolate them into git commands.
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;
export const assertSafeRef = (...refs: ReadonlyArray<string>): void => {
  for (const ref of refs) {
    if (!SAFE_REF.test(ref)) throw new Error(`unsafe ref: ${ref}`);
  }
};
