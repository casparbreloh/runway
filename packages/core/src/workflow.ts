import type { RunwayConfig, WorkflowBuilder, WorkflowDefinition } from "./types.ts";

const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const createWorkflow = (config: { id: string }): WorkflowBuilder => {
  if (!ID.test(config.id)) {
    throw new Error(`invalid workflow id ${JSON.stringify(config.id)}: must match ${String(ID)}`);
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
