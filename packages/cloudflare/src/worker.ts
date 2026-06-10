import { makeCtx, secretsOf } from "@runway/core";
import type { Primitives, WorkflowDefinition } from "@runway/core";
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

export { createRouter } from "./router.ts";

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
      return Promise.resolve(
        def.handler(
          makeCtx(primitives(step), {
            runId: event.instanceId,
            params: event.payload,
            secrets: secretsOf(def.secrets, this.env),
            env: this.env,
          }),
        ),
      );
    }
  };
