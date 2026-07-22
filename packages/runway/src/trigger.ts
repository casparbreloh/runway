import type { StandardSchemaV1 } from "@standard-schema/spec";

import { secretNameOf, type SecretRef } from "./secret.ts";
import type { WorkflowTrigger } from "./workflow.ts";

declare const EVENT: unique symbol;

export interface Trigger<E> {
  readonly [EVENT]: E;
}

export interface GitHubRepository {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
}

export interface GitHubPushEvent {
  readonly type: "push";
  readonly repository: GitHubRepository;
  readonly ref: string;
  readonly sha: string;
}

export type GitHubPullRequestAction = "opened" | "reopened" | "synchronize";

export interface GitHubPullRequestEvent<
  A extends GitHubPullRequestAction = GitHubPullRequestAction,
> {
  readonly type: "pull_request";
  readonly action: A;
  readonly repository: GitHubRepository;
  readonly number: number;
  readonly ref: string;
  readonly sha: string;
}

export interface GitHubPushFilter {
  readonly type: "push";
  readonly branches: readonly [string, ...string[]];
}

export interface GitHubPullRequestFilter<
  A extends readonly [GitHubPullRequestAction, ...GitHubPullRequestAction[]] = readonly [
    GitHubPullRequestAction,
    ...GitHubPullRequestAction[],
  ],
> {
  readonly type: "pull_request";
  readonly actions: A;
}

export type GitHubEventFilter = GitHubPushFilter | GitHubPullRequestFilter;

export type GitHubEventOf<F extends GitHubEventFilter> = F extends GitHubPushFilter
  ? GitHubPushEvent
  : F extends GitHubPullRequestFilter<infer A>
    ? GitHubPullRequestEvent<A[number]>
    : never;

export interface GitHubOptions<F extends readonly [GitHubEventFilter, ...GitHubEventFilter[]]> {
  readonly checkName: string;
  readonly events: F;
}

export interface GitHubTrigger<E> extends Trigger<E> {
  readonly type: "github";
  readonly checkName: string;
  readonly events: readonly GitHubEventFilter[];
}

export interface WebhookTimestamp {
  readonly source: "body" | "header";
  readonly field: string;
  readonly toleranceMs: number;
}

export interface WebhookTrigger<E> extends Trigger<E> {
  readonly type: "webhook";
  readonly path: string;
  readonly secret: SecretRef;
  readonly signatureHeader: string;
  readonly prefix?: string;
  readonly timestamp?: WebhookTimestamp;
  readonly schema?: StandardSchemaV1;
  readonly predicate?: (event: unknown) => boolean;
  filter<F extends E>(predicate: (event: E) => event is F): WebhookTrigger<F>;
}

export interface CronParams {
  readonly cron: string;
  readonly scheduledTime: number;
}

export interface CronTrigger extends Trigger<CronParams> {
  readonly type: "cron";
  readonly expression: string;
}

export interface WebhookOptions {
  path: string;
  secret: SecretRef;
  signatureHeader: string;
  prefix?: string;
  timestamp?: { source?: "body" | "header"; field: string; toleranceMs: number };
}

export const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const validateTrigger = (trigger: WorkflowTrigger): void => {
  if (!trigger || typeof trigger !== "object" || !("type" in trigger)) {
    throw new Error("invalid workflow trigger");
  }
  const type = (trigger as { type?: unknown }).type;
  if (type !== "cron" && type !== "webhook" && type !== "github") {
    throw new Error(`invalid workflow trigger type: ${String(type)}`);
  }
  if (trigger.type === "cron" && trigger.expression.trim().length === 0) {
    throw new Error("invalid workflow cron trigger: expression is required");
  }
  if (trigger.type === "github" && trigger.checkName.trim().length === 0) {
    throw new Error("invalid workflow GitHub trigger: checkName is required");
  }
  if (trigger.type === "github" && trigger.events.length === 0) {
    throw new Error("invalid workflow GitHub trigger: at least one event is required");
  }
  if (trigger.type === "github") {
    const eventTypes = new Set<string>();
    for (const event of trigger.events) {
      const eventType = (event as { type?: unknown }).type;
      if (eventType !== "push" && eventType !== "pull_request") {
        throw new Error(`invalid workflow GitHub trigger event type ${JSON.stringify(eventType)}`);
      }
      if (eventTypes.has(eventType)) {
        throw new Error(`duplicate workflow GitHub event filter ${JSON.stringify(eventType)}`);
      }
      eventTypes.add(eventType);
      if (eventType === "push") {
        const branches = (event as { branches?: unknown }).branches;
        if (!Array.isArray(branches) || branches.length === 0) {
          throw new Error("invalid workflow GitHub push branches: at least one branch is required");
        }
        for (const branch of branches) {
          if (typeof branch !== "string" || branch.trim().length === 0) {
            throw new Error("invalid workflow GitHub push branch: branch name is required");
          }
        }
      }
      if (eventType === "pull_request") {
        const actions = (event as { actions?: unknown }).actions;
        if (!Array.isArray(actions) || actions.length === 0) {
          throw new Error(
            "invalid workflow GitHub pull_request actions: at least one action is required",
          );
        }
        for (const action of actions) {
          if (action !== "opened" && action !== "reopened" && action !== "synchronize") {
            throw new Error(
              `invalid workflow GitHub pull_request action ${JSON.stringify(action)}`,
            );
          }
        }
      }
    }
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
    if (trigger.path === "/runway" || trigger.path.startsWith("/runway/")) {
      throw new Error(
        `invalid workflow trigger path ${JSON.stringify(trigger.path)}: reserved by Runway`,
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

export const github = <const F extends readonly [GitHubEventFilter, ...GitHubEventFilter[]]>(
  options: GitHubOptions<F>,
): GitHubTrigger<GitHubEventOf<F[number]>> =>
  ({
    type: "github",
    checkName: options.checkName,
    events: options.events,
  }) as unknown as GitHubTrigger<GitHubEventOf<F[number]>>;
