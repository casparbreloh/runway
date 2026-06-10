import { BINDING, validateTrigger } from "./trigger.ts";
import type {
  RunwayConfig,
  TriggerBuilder,
  WorkflowDefinition,
  WorkflowOptions,
  WorkflowTrigger,
} from "./types.ts";

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const validateSecrets = (secrets: ReadonlyArray<string> | undefined): void => {
  const seen = new Set<string>();
  for (const name of secrets ?? []) {
    if (!BINDING.test(name)) {
      throw new Error(
        `invalid workflow secret ${JSON.stringify(name)}: must be a valid binding name`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`duplicate workflow secret ${JSON.stringify(name)}`);
    }
    seen.add(name);
  }
};

export const createWorkflow = <SecretName extends string = never>(
  options: WorkflowOptions<SecretName>,
): TriggerBuilder<SecretName> => {
  if (!ID.test(options.id)) {
    throw new Error(`invalid workflow id ${JSON.stringify(options.id)}: must be kebab-case`);
  }
  validateSecrets(options.secrets);
  const secrets: ReadonlyArray<string> = options.secrets ?? [];
  return {
    trigger: (trigger: WorkflowTrigger) => {
      validateTrigger(trigger);
      if (trigger.type === "webhook" && !secrets.includes(trigger.secret)) {
        throw new Error(
          `workflow webhook secret ${JSON.stringify(trigger.secret)} must be declared in secrets`,
        );
      }
      return {
        handler: (fn: (ctx: never) => void | Promise<void>): WorkflowDefinition => ({
          __kind: "workflow",
          id: options.id,
          trigger,
          secrets,
          handler: fn as WorkflowDefinition["handler"],
        }),
      };
    },
  };
};

export const defineConfig = (config: RunwayConfig): RunwayConfig => config;
