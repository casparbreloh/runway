import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { SecretRef } from "./secrets.ts";

export interface StepContext {
  readonly id: string;
}

export interface ExecOptions {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface Step {
  do<T>(id: string, callback: (ctx: StepContext) => T | Promise<T>): Promise<T>;
  exec(id: string, command: string | ExecOptions): Promise<ExecResult>;
  sleep(id: string, durationMs: number): Promise<void>;
}

export interface Ctx<S extends string = string, E = unknown> {
  readonly runId: string;
  readonly secrets: { readonly [K in S]: string };
  readonly env: E;
  readonly step: Step;
}

export type TriggerContext<S extends string> = {
  readonly secrets: { readonly [K in S]: SecretRef<K> };
};

declare const EVENT: unique symbol;

export interface Trigger<E> {
  readonly [EVENT]?: E;
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

export type WorkflowTrigger = WebhookTrigger<unknown> | CronTrigger;

export interface WorkflowDefinition {
  readonly __kind: "workflow";
  readonly id: string;
  readonly trigger: WorkflowTrigger;
  readonly secrets: ReadonlyArray<string>;
  readonly handler: (ctx: Ctx, event: unknown) => void | Promise<void>;
}

export interface Primitives {
  readonly step: {
    do<T>(id: string, fn: () => Promise<T>): Promise<T>;
    exec(id: string, command: string | ExecOptions): Promise<ExecResult>;
    sleep(id: string, durationMs: number): Promise<void>;
  };
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
