import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { makeCtx, secretsOf } from "./ctx.ts";
import { RUNNER_BRIDGE_BINDING } from "./runner-config.ts";
import { ManagedRunner } from "./runner.ts";
import type { RunnerBridge } from "./runner.ts";
import type { Primitives, WorkflowDefinition } from "./types.ts";

export { createRunnerAdapter } from "./runner-adapter.ts";

export { createRouter } from "./router.ts";
export type { RouterEntry, WorkflowStarter } from "./router.ts";

interface WorkflowBinding {
  create(opts: { params: unknown }): Promise<{ id: string | Promise<string> }>;
}

type DynamicWorkerEnv = Record<string, unknown> & {
  WORKFLOWS?: WorkflowBinding;
  [RUNNER_BRIDGE_BINDING]?: RunnerBridge;
};

interface RunRuntime {
  readonly primitives: Primitives;
  cleanup(): Promise<void>;
}

const makeRunRuntime = (
  step: WorkflowStep,
  bridge: RunnerBridge | undefined,
  runId: string,
  secrets: ReadonlyArray<string>,
): RunRuntime => {
  const runner = new ManagedRunner(bridge, runId, secrets);
  return {
    primitives: {
      step: {
        do: <T>(id: string, fn: () => Promise<T>): Promise<T> =>
          step.do(id, fn as () => Promise<never>) as Promise<T>,
        exec: (id, command) =>
          runner.exec(id, command, (callback) =>
            step.do(id, async (ctx) => await callback(ctx), {
              rollback: () => runner.cleanup(),
            }),
          ),
        sleep: (id: string, durationMs: number): Promise<void> => step.sleep(id, durationMs),
      },
    },
    cleanup: () => runner.cleanup(),
  };
};

export const toEntrypoint = (
  def: WorkflowDefinition,
): typeof WorkflowEntrypoint<unknown, unknown> =>
  class extends WorkflowEntrypoint<unknown, unknown> {
    override async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<unknown> {
      const bridge = (this.env as DynamicWorkerEnv)[RUNNER_BRIDGE_BINDING];
      const secrets = secretsOf(def.secrets, this.env);
      const runtime = makeRunRuntime(step, bridge, event.instanceId, Object.values(secrets));
      let completed = false;
      try {
        const result = await def.handler(
          makeCtx(runtime.primitives, {
            runId: event.instanceId,
            secrets,
            env: this.env,
          }),
          event.payload,
        );
        completed = true;
        return result;
      } finally {
        if (completed) await runtime.cleanup();
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
