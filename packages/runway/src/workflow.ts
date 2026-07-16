import type { Run } from "./run.ts";
import { secretNameOf, secretRef } from "./secrets.ts";
import { BINDING, validateTrigger } from "./trigger.ts";
import type { Trigger, TriggerContext, WorkflowDefinition, WorkflowTrigger } from "./types.ts";

const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const validateWorkflowId = (id: string): void => {
  if (!ID.test(id)) {
    throw new Error(`invalid workflow id ${JSON.stringify(id)}: must be kebab-case`);
  }
};

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

export function workflow<const S extends readonly string[] = readonly [], E = unknown>(opts: {
  id: string;
  secrets?: S;
  trigger: (ctx: TriggerContext<S[number]>) => Trigger<E>;
}): {
  run(fn: (run: Run<S[number]>, event: E) => void | Promise<void>): WorkflowDefinition;
} {
  validateWorkflowId(opts.id);
  validateSecrets(opts.secrets);
  const secrets: ReadonlyArray<string> = opts.secrets ?? [];
  const context = {
    secrets: Object.fromEntries(secrets.map((name) => [name, secretRef(name)])),
  } as TriggerContext<S[number]>;
  const trigger = opts.trigger(context) as WorkflowTrigger;
  validateTrigger(trigger);
  if (trigger.type === "webhook" && !secrets.includes(secretNameOf(trigger.secret))) {
    throw new Error(
      `workflow webhook secret ${JSON.stringify(secretNameOf(trigger.secret))} must be declared in secrets`,
    );
  }
  return {
    run: (fn) => ({
      __kind: "workflow",
      id: opts.id,
      trigger,
      secrets,
      run: fn as unknown as WorkflowDefinition["run"],
    }),
  };
}
