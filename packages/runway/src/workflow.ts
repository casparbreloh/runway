import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { makeRunwayStep, type RunwayStep } from "./step.ts";

export type Verify = (ctx: {
  readonly raw: string;
  readonly req: Request;
  readonly env: Env;
}) => boolean | Promise<boolean>;

export interface Trigger<T> {
  readonly path: string;
  readonly method: "POST" | "GET";
  readonly verify?: Verify;
  readonly __payload?: T;
}

export const webhook = <T>(cfg: {
  path: string;
  method?: "POST" | "GET";
  verify?: Verify;
}): Trigger<T> => ({
  path: cfg.path,
  method: cfg.method ?? "POST",
  ...(cfg.verify ? { verify: cfg.verify } : {}),
});

export interface WorkflowDef<T> {
  readonly name: string;
  readonly trigger: Trigger<T>;
  readonly run: (event: WorkflowEvent<T>, step: RunwayStep, env: Env) => Promise<unknown>;
}

export const workflow = <T>(def: WorkflowDef<T>): WorkflowDef<T> => def;

export const toEntrypoint = <T>(def: WorkflowDef<T>): typeof WorkflowEntrypoint<Env, T> =>
  class extends WorkflowEntrypoint<Env, T> {
    override run(event: WorkflowEvent<T>, step: WorkflowStep): Promise<unknown> {
      return def.run(event, makeRunwayStep(step, this.env, event.instanceId), this.env);
    }
  };

export interface RouterApp {
  fetch(req: Request, env: Env): Promise<Response>;
}

const bindingName = (name: string): string => name.toUpperCase().replace(/-/g, "_");

const workflowBinding = (env: Env, name: string): Workflow | undefined =>
  (env as unknown as Record<string, Workflow | undefined>)[bindingName(name)];

export const createRouter = (
  defs: ReadonlyArray<{ readonly name: string; readonly trigger: Trigger<unknown> }>,
): RouterApp => ({
  async fetch(req, env) {
    const url = new URL(req.url);
    for (const def of defs) {
      const { trigger } = def;
      if (trigger.path !== url.pathname || trigger.method !== req.method) continue;

      const raw = await req.text();
      if (trigger.verify && !(await trigger.verify({ raw, req, env }))) {
        return new Response("invalid signature", { status: 401 });
      }
      let params: unknown;
      try {
        params = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        return new Response("invalid json", { status: 400 });
      }

      const wf = workflowBinding(env, def.name);
      if (!wf) return new Response(`no binding for ${def.name}`, { status: 500 });
      const instance = await wf.create({ params });
      return Response.json({ id: instance.id }, { status: 202 });
    }
    return new Response("not found", { status: 404 });
  },
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
