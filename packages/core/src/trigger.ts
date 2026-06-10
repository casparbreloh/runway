import type { CronTrigger, WebhookOptions, WebhookTrigger, WorkflowTrigger } from "./types.ts";

export const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const validateTrigger = (trigger: WorkflowTrigger): void => {
  if (trigger.type === "cron" && trigger.cron.trim().length === 0) {
    throw new Error("invalid workflow cron trigger: expression is required");
  }
  if (trigger.type === "webhook") {
    if (!trigger.path.startsWith("/")) {
      throw new Error(
        `invalid workflow trigger path ${JSON.stringify(trigger.path)}: must start with "/"`,
      );
    }
    if (trigger.path.includes("//")) {
      throw new Error(
        `invalid workflow trigger path ${JSON.stringify(trigger.path)}: contains "//"`,
      );
    }
    if (!BINDING.test(trigger.secret)) {
      throw new Error(
        `invalid workflow webhook secret ${JSON.stringify(trigger.secret)}: must be a valid binding name`,
      );
    }
    if (trigger.header.length === 0) {
      throw new Error("invalid workflow webhook header: header is required");
    }
    if (trigger.timestamp && trigger.timestamp.toleranceMs <= 0) {
      throw new Error("invalid workflow webhook timestamp tolerance: must be positive");
    }
  }
};

export function webhook<SecretName extends string>(
  options: WebhookOptions<SecretName>,
): WebhookTrigger<unknown, SecretName>;
export function webhook<SecretName extends string, Body, Params>(
  options: WebhookOptions<SecretName>,
  handle: (body: Body) => Params | undefined,
): WebhookTrigger<NonNullable<Params>, SecretName>;
export function webhook<SecretName extends string>(
  options: WebhookOptions<SecretName>,
  handle?: (body: never) => unknown,
): WebhookTrigger<unknown, SecretName> {
  return {
    type: "webhook",
    path: options.path,
    secret: options.secret,
    header: options.header,
    ...(options.prefix ? { prefix: options.prefix } : {}),
    ...(options.timestamp
      ? { timestamp: { ...options.timestamp, source: options.timestamp.source ?? "body" } }
      : {}),
    ...(handle ? { handle: handle as (body: unknown) => unknown } : {}),
  };
}

export const cron = (expression: string): CronTrigger => ({
  type: "cron",
  cron: expression,
});
