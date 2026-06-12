import { getSandbox } from "@cloudflare/sandbox";
import type { Sandbox } from "@cloudflare/sandbox";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { makeCtx, secretsOf } from "./ctx.ts";
import type { Primitives, WorkflowDefinition } from "./types.ts";

export { createRouter } from "./router.ts";
export type { RouterEntry, WorkflowStarter } from "./router.ts";

interface WorkflowBinding {
  create(opts: { params: unknown }): Promise<{ id: string | Promise<string> }>;
}

type DynamicWorkerEnv = Record<string, unknown> & {
  WORKFLOWS?: WorkflowBinding;
  Sandbox?: DurableObjectNamespace<Sandbox>;
};

const primitives = (step: WorkflowStep, env: unknown): Primitives => ({
  step: <T>(id: string, fn: () => Promise<T>): Promise<T> =>
    step.do(id, fn as () => Promise<never>) as Promise<T>,
  sandbox: async (name) => {
    const binding = (env as DynamicWorkerEnv).Sandbox;
    if (!binding) throw new Error("missing sandbox binding: Sandbox");
    return getSandbox(binding, name);
  },
  sleep: (id: string, ms: number): Promise<void> => step.sleep(id, ms),
});

export const toEntrypoint = (
  def: WorkflowDefinition,
): typeof WorkflowEntrypoint<unknown, unknown> =>
  class extends WorkflowEntrypoint<unknown, unknown> {
    override async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<unknown> {
      return await def.handler(
        makeCtx(primitives(step, this.env), {
          runId: event.instanceId,
          secrets: secretsOf(def.secrets, this.env),
          env: this.env,
        }),
        event.payload,
      );
    }
  };

export const createWorkflowWorker = (): {
  fetch(req: Request, env: unknown): Promise<Response>;
} => ({
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    const workflow = (env as DynamicWorkerEnv).WORKFLOWS;
    if (!workflow) return new Response("no binding: WORKFLOWS", { status: 500 });
    const instance = await workflow.create({ params: await req.json() });
    return Response.json({ id: await instance.id });
  },
});
