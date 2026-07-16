import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { createRouter } from "./router.ts";
import { makeRun, secretsOf } from "./run.ts";
import type { RunOperations } from "./run.ts";
import type { HostCapability } from "./runner.ts";
import type { RunLifecycleState } from "./runner.ts";
import { Sandbox } from "./sandbox.ts";
import { source } from "./source.ts";
import type { SourceIdentity } from "./source.ts";
import type { WorkflowDefinition } from "./types.ts";
import { HOST_CAPABILITY_BINDING } from "./worker-contract.ts";

const SECRET_SNAPSHOT_STEP = "runway:secret-snapshot";
const GITHUB_START_STEP = "runway:github-in-progress";
const GITHUB_SUCCESS_STEP = "runway:github-success";
const GITHUB_FAILURE_STEP = "runway:github-failure";

interface WorkflowBinding {
  create(opts: { params: unknown }): Promise<{ id: string | Promise<string> }>;
}

type DynamicWorkerEnv = Record<string, unknown> & {
  WORKFLOWS?: WorkflowBinding;
  [HOST_CAPABILITY_BINDING]?: HostCapability;
};

interface RunRuntime {
  readonly operations: RunOperations;
  cleanup(): Promise<void>;
}

const makeRunRuntime = (
  step: WorkflowStep,
  host: HostCapability,
  runId: string,
  secrets: Readonly<Record<string, string>>,
  identity: SourceIdentity,
): RunRuntime => {
  const exactSource = source(identity, {
    prepare: async (requested) => await host.prepareSource({ runId, source: requested, secrets }),
  });
  const sandbox = new Sandbox({
    runId,
    secrets,
    source: exactSource,
    placement: {
      exec: async ({ step: durableStep, source: prepared, command, secrets: _secrets, ...rest }) =>
        await host.exec({
          ...rest,
          step: durableStep,
          source: prepared,
          options: command,
          secrets,
        }),
      destroy: async () => await host.destroy(runId, secrets),
    },
  });
  return {
    operations: {
      do: <T>(id: string, fn: () => Promise<T>): Promise<T> =>
        step.do(id, fn as () => Promise<never>) as Promise<T>,
      exec: (id, command) =>
        sandbox.exec(
          {
            id,
            run: async (work, rollback) =>
              await step.do(
                id,
                async (ctx) =>
                  await work({
                    count: ctx.step.count,
                    attempt: ctx.attempt,
                  }),
                { rollback },
              ),
          },
          command,
        ),
      sleep: (id: string, durationMs: number): Promise<void> => step.sleep(id, durationMs),
    },
    cleanup: () => sandbox.cleanup(),
  };
};

export const toEntrypoint = (
  def: WorkflowDefinition,
): typeof WorkflowEntrypoint<unknown, unknown> =>
  class extends WorkflowEntrypoint<unknown, unknown> {
    override async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<unknown> {
      const host = (this.env as DynamicWorkerEnv)[HOST_CAPABILITY_BINDING];
      if (!host) throw new Error(`missing host capability: ${HOST_CAPABILITY_BINDING}`);
      const reportLifecycle = async (state: RunLifecycleState): Promise<boolean> =>
        (await step.do(
          state === "in_progress"
            ? GITHUB_START_STEP
            : state === "success"
              ? GITHUB_SUCCESS_STEP
              : GITHUB_FAILURE_STEP,
          async () => (await host.reportRunLifecycle(event.instanceId, state)) as never,
        )) as boolean;
      if (!(await reportLifecycle("in_progress"))) return undefined;
      let secrets: Readonly<Record<string, string>>;
      try {
        const snapshot = await step.do(
          SECRET_SNAPSHOT_STEP,
          async () => (await host.captureSecrets(event.instanceId)) as never,
        );
        secrets = secretsOf(def.secrets, await host.restoreSecrets(event.instanceId, snapshot));
      } catch (error) {
        await reportLifecycle("failure");
        throw error;
      }
      const runtime = makeRunRuntime(step, host, event.instanceId, secrets, await host.source());
      let result: unknown;
      let failed = false;
      let failure: unknown;
      try {
        result = await def.run(
          makeRun(runtime.operations, {
            runId: event.instanceId,
            secrets,
          }),
          event.payload,
        );
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        await runtime.cleanup();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
      if (failed) {
        await reportLifecycle("failure");
        throw failure;
      }
      await reportLifecycle("success");
      return result;
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
