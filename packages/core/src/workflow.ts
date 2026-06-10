import { validateTrigger } from "./trigger.ts";
import type {
  RunwayConfig,
  WorkflowBuilder,
  WorkflowDefinition,
  WorkflowOptions,
} from "./types.ts";

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const createWorkflow = (options: WorkflowOptions): WorkflowBuilder => {
  if (!ID.test(options.id)) {
    throw new Error(`invalid workflow id ${JSON.stringify(options.id)}: must be kebab-case`);
  }
  validateTrigger(options.trigger);
  return {
    handler: (fn): WorkflowDefinition => ({
      __kind: "workflow",
      id: options.id,
      trigger: options.trigger,
      handler: fn,
    }),
  };
};

export const defineConfig = (config: RunwayConfig): RunwayConfig => config;
