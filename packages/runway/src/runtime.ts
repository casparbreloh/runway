import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { makeCtx, secretsOf } from "./ctx.ts";
import { ManagedRunner } from "./runner.ts";
import type { RunnerBridge } from "./runner.ts";
import type { Primitives, WorkflowDefinition } from "./types.ts";

export { executeCommand, runnerIdOf } from "./runner.ts";
export type { NormalizedExecOptions, RunnerBridge, SandboxExecutor } from "./runner.ts";

export { createRouter } from "./router.ts";
export type { RouterEntry, WorkflowStarter } from "./router.ts";

interface WorkflowBinding {
  create(opts: { params: unknown }): Promise<{ id: string | Promise<string> }>;
}

type DynamicWorkerEnv = Record<string, unknown> & {
  WORKFLOWS?: WorkflowBinding;
  RUNWAY_RUNNER?: RunnerBridge;
};

const primitives = (step: WorkflowStep, runner: ManagedRunner): Primitives => ({
  step: {
    do: <T>(id: string, fn: () => Promise<T>): Promise<T> =>
      step.do(id, fn as () => Promise<never>) as Promise<T>,
    exec: (id, command) => {
      runner.activate();
      return step.do(id, () => runner.exec(id, command) as Promise<never>) as ReturnType<
        Primitives["step"]["exec"]
      >;
    },
    sleep: (id: string, durationMs: number): Promise<void> => step.sleep(id, durationMs),
  },
});

export const toEntrypoint = (
  def: WorkflowDefinition,
): typeof WorkflowEntrypoint<unknown, unknown> =>
  class extends WorkflowEntrypoint<unknown, unknown> {
    override async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<unknown> {
      const bridge = (this.env as DynamicWorkerEnv).RUNWAY_RUNNER;
      const runner = new ManagedRunner(
        bridge ?? {
          exec: async () => {
            throw new Error("missing runner binding: RUNWAY_RUNNER");
          },
          destroy: async () => {},
        },
        event.instanceId,
        Object.values(secretsOf(def.secrets, this.env)),
      );
      try {
        return await def.handler(
          makeCtx(primitives(step, runner), {
            runId: event.instanceId,
            secrets: secretsOf(def.secrets, this.env),
            env: this.env,
          }),
          event.payload,
        );
      } finally {
        await runner.cleanup();
      }
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
