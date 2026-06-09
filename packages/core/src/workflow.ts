import type { RunwayConfig, WorkflowBuilder, WorkflowDefinition } from "./types.ts";

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const createWorkflow = (config: { id: string }): WorkflowBuilder => {
  if (!ID.test(config.id)) {
    throw new Error(`invalid workflow id ${JSON.stringify(config.id)}: must be kebab-case`);
  }
  return {
    handler: (fn): WorkflowDefinition => ({
      __kind: "workflow",
      id: config.id,
      handler: fn,
    }),
  };
};

export const defineConfig = (config: RunwayConfig): RunwayConfig => config;
