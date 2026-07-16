import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { Run } from "./run.ts";
import type { SecretRef } from "./secrets.ts";

export type TriggerContext<S extends string> = {
  readonly secrets: { readonly [K in S]: SecretRef<K> };
};

declare const EVENT: unique symbol;

export interface Trigger<E> {
  readonly [EVENT]: E;
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

export interface WebhookOptions {
  path: string;
  secret: SecretRef;
  signatureHeader: string;
  prefix?: string;
  timestamp?: { source?: "body" | "header"; field: string; toleranceMs: number };
}

export type WorkflowTrigger = WebhookTrigger<unknown> | CronTrigger | GitHubTrigger<unknown>;

export interface WorkflowDefinition {
  readonly __kind: "workflow";
  readonly id: string;
  readonly trigger: WorkflowTrigger;
  readonly secrets: ReadonlyArray<string>;
  readonly run: (run: Run, event: unknown) => void | Promise<void>;
}

export interface RegisteredWorkflow {
  readonly path: string;
  readonly exportName: string;
  readonly def: WorkflowDefinition;
}

export type Registry = ReadonlyArray<RegisteredWorkflow>;

export interface ProgressEvent {
  readonly step: "load" | "build" | "deploy";
  readonly status: "start" | "done";
}
