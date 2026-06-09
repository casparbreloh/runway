import { makeCtx } from "@runway/core";
import type { Primitives, WorkflowDefinition } from "@runway/core";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

const primitives = (step: WorkflowStep): Primitives => ({
  step: <T>(id: string, fn: () => Promise<T>): Promise<T> =>
    step.do(id, fn as () => Promise<never>) as Promise<T>,
  sleep: (id: string, ms: number): Promise<void> => step.sleep(id, ms),
});

export const toEntrypoint = (
  def: WorkflowDefinition,
): typeof WorkflowEntrypoint<unknown, unknown> =>
  class extends WorkflowEntrypoint<unknown, unknown> {
    override run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<unknown> {
      return Promise.resolve(def.handler(makeCtx(primitives(step), { runId: event.instanceId })));
    }
  };

export const createRouter = (
  entries: ReadonlyArray<{ readonly id: string; readonly binding: string }>,
): { fetch(req: Request, env: unknown): Promise<Response> } => ({
  async fetch(req, env) {
    const match = new URL(req.url).pathname.match(/^\/runs\/([^/]+)$/);
    if (!match) return new Response("not found", { status: 404 });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const entry = entries.find((e) => e.id === match[1]);
    if (!entry) return new Response(`no workflow: ${match[1]}`, { status: 404 });
    let params: unknown;
    try {
      const raw = await req.text();
      params = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    const wf = (env as Record<string, Workflow | undefined>)[entry.binding];
    if (!wf) return new Response(`no binding: ${entry.binding}`, { status: 500 });
    const instance = await wf.create({ params });
    return Response.json({ id: instance.id }, { status: 202 });
  },
});
