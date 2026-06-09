import { validateTrigger } from "./trigger.ts";
import type {
  RunwayConfig,
  WorkflowBuilder,
  WorkflowDefinition,
  WorkflowTrigger,
} from "./types.ts";

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const createWorkflow = (config: {
  id: string;
  trigger: WorkflowTrigger;
}): WorkflowBuilder => {
  if (!ID.test(config.id)) {
    throw new Error(`invalid workflow id ${JSON.stringify(config.id)}: must be kebab-case`);
  }
  validateTrigger(config.trigger);
  return {
    handler: (fn): WorkflowDefinition => ({
      __kind: "workflow",
      id: config.id,
      trigger: config.trigger,
      handler: fn,
    }),
  };
};

export const defineConfig = (config: RunwayConfig): RunwayConfig => config;
