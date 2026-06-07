import { Schema } from "effect";

import { AgentName } from "./domain.ts";

const Sign = Schema.Struct({
  header: Schema.String,
  alg: Schema.optional(Schema.Literal("sha256")),
  encoding: Schema.optional(Schema.Union([Schema.Literal("hex"), Schema.Literal("base64")])),
});

const Webhook = Schema.Struct({
  webhook: Schema.Struct({
    secret: Schema.String,
    sign: Schema.optional(Sign),
    when: Schema.optional(Schema.String),
  }),
});

const Cron = Schema.Struct({ cron: Schema.String });

export const Trigger = Schema.Union([Webhook, Cron]);
export type Trigger = typeof Trigger.Type;

export const isWebhook = (t: Trigger | undefined): t is typeof Webhook.Type =>
  t !== undefined && "webhook" in t;
export const isCron = (t: Trigger | undefined): t is typeof Cron.Type =>
  t !== undefined && "cron" in t;

const base = {
  id: Schema.optional(Schema.String),
  when: Schema.optional(Schema.String),
  forEach: Schema.optional(Schema.String),
};

export const RunStep = Schema.Struct({
  ...base,
  run: Schema.String,
  pr: Schema.optional(Schema.Boolean),
  branch: Schema.optional(Schema.String),
});
export type RunStep = typeof RunStep.Type;

export const ShellStep = Schema.Struct({ ...base, shell: Schema.String });
export type ShellStep = typeof ShellStep.Type;

export const HttpStep = Schema.Struct({
  ...base,
  http: Schema.Struct({
    url: Schema.String,
    method: Schema.optional(Schema.String),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    json: Schema.optional(Schema.Unknown),
    body: Schema.optional(Schema.String),
  }),
});
export type HttpStep = typeof HttpStep.Type;

export const Step = Schema.Union([RunStep, ShellStep, HttpStep]);
export type Step = typeof Step.Type;

export const WorkflowManifest = Schema.Struct({
  id: Schema.String,
  trigger: Schema.optional(Trigger),
  repo: Schema.optional(Schema.String),
  agent: Schema.optional(AgentName),
  steps: Schema.Array(Step),
});
export type WorkflowManifest = typeof WorkflowManifest.Type;

// The validation pipeline: agent-written workflows decode through this or are rejected.
export const decodeWorkflow = Schema.decodeUnknownEffect(WorkflowManifest);

export const isRun = (s: Step): s is RunStep => "run" in s;
export const isShell = (s: Step): s is ShellStep => "shell" in s;
export const isHttp = (s: Step): s is HttpStep => "http" in s;
