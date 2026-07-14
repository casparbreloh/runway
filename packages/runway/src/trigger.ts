import type { StandardSchemaV1 } from "@standard-schema/spec";

import { secretNameOf } from "./secrets.ts";
import type { SecretRef } from "./secrets.ts";
import type {
  CronTrigger,
  WebhookOptions,
  WebhookTimestamp,
  WebhookTrigger,
  WorkflowTrigger,
} from "./types.ts";

export const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const validateTrigger = (trigger: WorkflowTrigger): void => {
  if (!trigger || typeof trigger !== "object" || !("type" in trigger)) {
    throw new Error("invalid workflow trigger");
  }
  const type = (trigger as { type?: unknown }).type;
  if (type !== "cron" && type !== "webhook") {
    throw new Error(`invalid workflow trigger type: ${String(type)}`);
  }
  if (trigger.type === "cron" && trigger.expression.trim().length === 0) {
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
    const secret = secretNameOf(trigger.secret);
    if (!BINDING.test(secret)) {
      throw new Error(
        `invalid workflow webhook secret ${JSON.stringify(secret)}: must be a valid binding name`,
      );
    }
    if (trigger.signatureHeader.length === 0) {
      throw new Error("invalid workflow webhook signatureHeader: a signature header is required");
    }
    if (trigger.timestamp && trigger.timestamp.toleranceMs <= 0) {
      throw new Error("invalid workflow webhook timestamp tolerance: must be positive");
    }
  }
};

interface WebhookData {
  readonly type: "webhook";
  readonly path: string;
  readonly secret: SecretRef;
  readonly signatureHeader: string;
  readonly prefix?: string;
  readonly timestamp?: WebhookTimestamp;
  readonly schema?: StandardSchemaV1;
  readonly predicate?: (event: unknown) => boolean;
}

const webhookTrigger = <E>(data: WebhookData): WebhookTrigger<E> =>
  ({
    ...data,
    filter<F extends E>(predicate: (event: E) => event is F): WebhookTrigger<F> {
      const prev = data.predicate;
      const next = predicate as (event: unknown) => boolean;
      return webhookTrigger<F>({
        ...data,
        predicate: prev ? (event) => prev(event) && next(event) : next,
      });
    },
  }) as WebhookTrigger<E>;

export function webhook<S extends StandardSchemaV1>(
  options: WebhookOptions & { schema: S },
): WebhookTrigger<StandardSchemaV1.InferOutput<S>>;
export function webhook(options: WebhookOptions & { schema?: never }): WebhookTrigger<unknown>;
export function webhook<T>(options: WebhookOptions & { schema?: never }): WebhookTrigger<T>;
export function webhook(
  options: WebhookOptions & { schema?: StandardSchemaV1 },
): WebhookTrigger<unknown> {
  return webhookTrigger({
    type: "webhook",
    path: options.path,
    secret: options.secret,
    signatureHeader: options.signatureHeader,
    ...(options.prefix ? { prefix: options.prefix } : {}),
    ...(options.timestamp
      ? { timestamp: { ...options.timestamp, source: options.timestamp.source ?? "body" } }
      : {}),
    ...(options.schema ? { schema: options.schema } : {}),
  });
}

export const cron = (expression: string): CronTrigger =>
  ({
    type: "cron",
    expression,
  }) as CronTrigger;
