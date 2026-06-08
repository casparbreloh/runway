import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { makeRunwayStep } from "./steps.ts";
import type { Trigger, WorkflowDef } from "./types.ts";

declare global {
  interface Env {
    readonly Sandbox: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
  }
}

export { Sandbox } from "@cloudflare/sandbox";

export const toEntrypoint = <T>(def: WorkflowDef<T>): typeof WorkflowEntrypoint<Env, T> =>
  class extends WorkflowEntrypoint<Env, T> {
    override run(event: WorkflowEvent<T>, step: WorkflowStep): Promise<unknown> {
      return def.run(event, makeRunwayStep(step, this.env, event.instanceId), this.env);
    }
  };

export interface RouterApp {
  fetch(req: Request, env: Env): Promise<Response>;
}

export interface RouterEntry {
  readonly trigger: Trigger<unknown>;
  readonly binding: string;
}

export const createRouter = (entries: ReadonlyArray<RouterEntry>): RouterApp => ({
  async fetch(req, env) {
    const url = new URL(req.url);
    for (const { trigger, binding } of entries) {
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

      const wf = (env as unknown as Record<string, Workflow | undefined>)[binding];
      if (!wf) return new Response(`no binding for ${binding}`, { status: 500 });
      const instance = await wf.create({ params });
      return Response.json({ id: instance.id }, { status: 202 });
    }
    return new Response("not found", { status: 404 });
  },
});
