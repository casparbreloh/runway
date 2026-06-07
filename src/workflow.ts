import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { z } from "zod";

import type { Env } from "./env.ts";
import { makeRunwayStep, type RunwayStep } from "./step.ts";

// --- triggers -------------------------------------------------------------
// A trigger is a typed descriptor read three ways: the compiler infers `event.payload`
// from it, the router uses it to route + verify inbound requests, and the entrypoint
// ignores it (Cloudflare delivers the payload). One declaration, no duplicated glue.

export interface CronEvent {
  readonly scheduledTime: number;
  readonly cron: string;
}

// Verifies an inbound webhook against its already-read raw body (read once, before parse).
export type Verify = (ctx: {
  readonly raw: string;
  readonly req: Request;
  readonly env: Env;
}) => boolean | Promise<boolean>;

export interface WebhookTrigger<T> {
  readonly kind: "webhook";
  readonly path: string;
  readonly method: "POST" | "GET";
  readonly schema: z.ZodType<T>;
  readonly verify?: Verify;
}
export interface CronTrigger<T> {
  readonly kind: "cron";
  readonly cron: string;
  readonly __event?: T;
}
export interface ManualTrigger<T> {
  readonly kind: "manual";
  readonly schema: z.ZodType<T>;
}
export type Trigger<T> = WebhookTrigger<T> | CronTrigger<T> | ManualTrigger<T>;

export const webhook = <S extends z.ZodType>(cfg: {
  path: string;
  method?: "POST" | "GET";
  schema: S;
  verify?: Verify;
}): Trigger<z.infer<S>> => ({
  kind: "webhook",
  path: cfg.path,
  method: cfg.method ?? "POST",
  schema: cfg.schema,
  ...(cfg.verify ? { verify: cfg.verify } : {}),
});

export const cron = (expr: string): Trigger<CronEvent> => ({ kind: "cron", cron: expr });

export const manual = <S extends z.ZodType>(schema: S): Trigger<z.infer<S>> => ({
  kind: "manual",
  schema,
});

// --- workflow definition --------------------------------------------------
export interface WorkflowDef<T> {
  readonly name: string;
  readonly trigger: Trigger<T>;
  readonly run: (event: WorkflowEvent<T>, step: RunwayStep, env: Env) => Promise<unknown>;
}

// Author a workflow. `T` flows from the trigger's schema into `event.payload` — never
// restated. The returned def both compiles to a WorkflowEntrypoint (toEntrypoint) and is
// read by the router (createRouter).
export const workflow = <T>(def: WorkflowDef<T>): WorkflowDef<T> => def;

// Compile a def down to a Cloudflare WorkflowEntrypoint subclass. Export the result under a
// name matching the wrangler `class_name` binding.
export const toEntrypoint = <T>(def: WorkflowDef<T>): typeof WorkflowEntrypoint<Env, T> =>
  class extends WorkflowEntrypoint<Env, T> {
    override run(event: WorkflowEvent<T>, step: WorkflowStep): Promise<unknown> {
      return def.run(event, makeRunwayStep(step, this.env), this.env);
    }
  };

// --- front worker ---------------------------------------------------------
export interface RouterApp {
  fetch(req: Request, env: Env): Promise<Response>;
  scheduled(controller: ScheduledController, env: Env): Promise<void>;
}

// Workflow name -> binding name: "linear-to-pr" -> "LINEAR_TO_PR".
export const bindingName = (name: string): string => name.toUpperCase().replace(/-/g, "_");

const workflowBinding = (env: Env, name: string): Workflow | undefined =>
  (env as unknown as Record<string, Workflow | undefined>)[bindingName(name)];

// Build the front Worker: Cloudflare Workflows can't receive webhooks, so this Worker
// matches a request to a trigger, verifies + parses it, then creates a workflow instance.
export const createRouter = (
  // Heterogeneous registry: each def keeps its own payload type, erased here for the router.
  // oxlint-disable-next-line typescript/no-explicit-any
  defs: ReadonlyArray<WorkflowDef<any>>,
): RouterApp => ({
  async fetch(req, env) {
    const url = new URL(req.url);
    for (const def of defs) {
      const t = def.trigger;
      if (t.kind !== "webhook" || t.path !== url.pathname || t.method !== req.method) continue;

      const raw = await req.text();
      if (t.verify && !(await t.verify({ raw, req, env }))) {
        return new Response("invalid signature", { status: 401 });
      }
      let payload: unknown;
      try {
        payload = raw.length > 0 ? JSON.parse(raw) : {};
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      const parsed = t.schema.safeParse(payload);
      if (!parsed.success)
        return new Response(`bad payload: ${parsed.error.message}`, { status: 400 });

      const wf = workflowBinding(env, def.name);
      if (!wf) return new Response(`no binding for ${def.name}`, { status: 500 });
      const instance = await wf.create({ params: parsed.data });
      return Response.json({ id: instance.id }, { status: 202 });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller, env) {
    for (const def of defs) {
      if (def.trigger.kind !== "cron" || def.trigger.cron !== controller.cron) continue;
      const wf = workflowBinding(env, def.name);
      if (wf) {
        await wf.create({
          params: { scheduledTime: controller.scheduledTime, cron: controller.cron },
        });
      }
    }
  },
});

// --- webhook verification helper -----------------------------------------
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
