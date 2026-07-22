import { secretNameOf, secretRef, type SecretRef } from "./secret.ts";
import type { Step } from "./step.ts";
import { toolProviders, type ToolProvider, type Tools } from "./tools.ts";
import { BINDING, validateTrigger } from "./trigger.ts";
import type { CronTrigger, GitHubTrigger, Trigger, WebhookTrigger } from "./trigger.ts";

export type TriggerContext<S extends string> = {
  readonly secrets: { readonly [K in S]: SecretRef<K> };
};

export type WorkflowTrigger = WebhookTrigger<unknown> | CronTrigger | GitHubTrigger<unknown>;

export interface WorkflowDefinition {
  readonly __kind: "workflow";
  readonly id: string;
  readonly trigger?: WorkflowTrigger;
  readonly secrets: ReadonlyArray<string>;
  readonly tools?: readonly ToolProvider[];
  readonly run: (step: Step, event: unknown) => void | Promise<void>;
}

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

interface WorkflowOptions<S extends readonly string[]> {
  readonly id: string;
  readonly secrets?: S;
  readonly tools?: Tools;
}

interface WorkflowBuilder<S extends readonly string[], E> {
  run(fn: (run: Step<S[number]>, event: E) => void | Promise<void>): WorkflowDefinition;
}

type TriggerEvent<T> = T extends Trigger<infer E> ? E : undefined;

export function workflow<
  const S extends readonly string[] = readonly [],
  T extends Trigger<unknown> | undefined = undefined,
>(
  opts: WorkflowOptions<S> & {
    trigger?: (ctx: TriggerContext<S[number]>) => T;
  },
): WorkflowBuilder<S, TriggerEvent<T>> {
  validateWorkflowId(opts.id);
  validateSecrets(opts.secrets);
  const tools = toolProviders(opts.tools);
  const secrets: ReadonlyArray<string> = opts.secrets ?? [];
  const context = {
    secrets: Object.fromEntries(secrets.map((name) => [name, secretRef(name)])),
  } as TriggerContext<S[number]>;
  const trigger = opts.trigger?.(context) as WorkflowTrigger | undefined;
  if (trigger !== undefined) validateTrigger(trigger);
  if (trigger?.type === "webhook" && !secrets.includes(secretNameOf(trigger.secret))) {
    throw new Error(
      `workflow webhook secret ${JSON.stringify(secretNameOf(trigger.secret))} must be declared in secrets`,
    );
  }
  return {
    run: (fn) => ({
      __kind: "workflow",
      id: opts.id,
      ...(trigger ? { trigger } : {}),
      secrets,
      ...(tools.length > 0 ? { tools } : {}),
      run: fn as unknown as WorkflowDefinition["run"],
    }),
  };
}
