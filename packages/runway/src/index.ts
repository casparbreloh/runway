import type { Trigger, Verify, WorkflowDef } from "./types.ts";

export const workflow = <T>(def: WorkflowDef<T>): WorkflowDef<T> => def;

export const webhook = <T>(cfg: {
  path: string;
  method?: "POST" | "GET";
  verify?: Verify;
}): Trigger<T> => ({
  path: cfg.path,
  method: cfg.method ?? "POST",
  ...(cfg.verify ? { verify: cfg.verify } : {}),
});

export const hmac =
  (secretOf: (env: Env) => string, opts: { header?: string } = {}): Verify =>
  async ({ raw, req, env }) => {
    const header = req.headers.get(opts.header ?? "x-signature");
    if (!header) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secretOf(env)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return timingSafeEqual(hex, header.trim().replace(/^sha256=/, ""));
  };

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export type {
  AgentArgs,
  AgentResult,
  HttpArgs,
  HttpResult,
  RunwayStep,
  SandboxArgs,
  SandboxHandle,
  ShellArgs,
  ShellResult,
  Trigger,
  Verify,
  WorkflowDef,
} from "./types.ts";
