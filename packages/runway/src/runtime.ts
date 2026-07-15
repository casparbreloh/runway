import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { makeCtx, secretsOf } from "./ctx.ts";
import { createRouter } from "./router.ts";
import { ManagedRunner } from "./runner.ts";
import type { HostCapability } from "./runner.ts";
import type { Primitives, WorkflowDefinition } from "./types.ts";
import { HOST_CAPABILITY_BINDING } from "./worker-contract.ts";

const SECRET_SNAPSHOT_STEP = "runway:secret-snapshot";

interface WorkflowBinding {
  create(opts: { params: unknown }): Promise<{ id: string | Promise<string> }>;
}

type DynamicWorkerEnv = Record<string, unknown> & {
  WORKFLOWS?: WorkflowBinding;
  [HOST_CAPABILITY_BINDING]?: HostCapability;
};

interface RunRuntime {
  readonly primitives: Primitives;
  cleanup(): Promise<void>;
}

const makeRunRuntime = (
  step: WorkflowStep,
  host: HostCapability,
  runId: string,
  secrets: Readonly<Record<string, string>>,
): RunRuntime => {
  const runner = new ManagedRunner(host, runId, secrets);
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
      const host = (this.env as DynamicWorkerEnv)[HOST_CAPABILITY_BINDING];
      if (!host) throw new Error(`missing host capability: ${HOST_CAPABILITY_BINDING}`);
      const snapshot = await step.do(
        SECRET_SNAPSHOT_STEP,
        async () => (await host.captureSecrets(event.instanceId)) as never,
      );
      const secrets = secretsOf(def.secrets, await host.restoreSecrets(event.instanceId, snapshot));
      const runtime = makeRunRuntime(step, host, event.instanceId, secrets);
      let completed = false;
      try {
        const result = await def.handler(
          makeCtx(runtime.primitives, {
            runId: event.instanceId,
            secrets,
            env: {},
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

export const createWorkflowWorker = (
  def: WorkflowDefinition,
): {
  fetch(req: Request, env: unknown): Promise<Response>;
} => ({
  async fetch(req, env) {
    const dynamicEnv = env as DynamicWorkerEnv;
    const workflow = dynamicEnv.WORKFLOWS;
    if (!workflow) return new Response("no binding: WORKFLOWS", { status: 500 });
    const host = dynamicEnv[HOST_CAPABILITY_BINDING];
    if (!host) {
      return new Response(`missing host capability: ${HOST_CAPABILITY_BINDING}`, { status: 500 });
    }
    const secrets = secretsOf(def.secrets, await host.secrets());
    const router = createRouter([{ id: def.id, trigger: def.trigger }], {
      async start(_entry, event) {
        const instance = await workflow.create({ params: event });
        return { id: await instance.id };
      },
    });
    const routerEnv = { ...secrets };
    if (req.headers.get("x-runway-trigger") === "scheduled") {
      const event = (await req.json()) as { cron: string; scheduledTime: number };
      await router.scheduled(event, routerEnv);
      return new Response(null, { status: 204 });
    }
    return await router.fetch(req, routerEnv);
  },
});
