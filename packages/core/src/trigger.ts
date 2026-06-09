import type { RawHmacSha256WebhookAuthConfig, WebhookAuth, WorkflowTrigger } from "./types.ts";

const PATH = /^\//;
const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const validateTrigger = (trigger: WorkflowTrigger): void => {
  if (trigger.type === "cron" && trigger.cron.trim().length === 0) {
    throw new Error("invalid workflow cron trigger: expression is required");
  }
  if (trigger.type === "webhook") {
    if (!PATH.test(trigger.path)) {
      throw new Error(
        `invalid workflow trigger path ${JSON.stringify(trigger.path)}: must start with "/"`,
      );
    }
    if (trigger.path.includes("//")) {
      throw new Error(
        `invalid workflow trigger path ${JSON.stringify(trigger.path)}: contains "//"`,
      );
    }
    if (trigger.auth.secret.length === 0) {
      throw new Error("invalid workflow webhook secret: must name an env var");
    }
    if (!BINDING.test(trigger.auth.secret)) {
      throw new Error(
        `invalid workflow webhook secret ${JSON.stringify(trigger.auth.secret)}: must be a valid binding name`,
      );
    }
    if (trigger.auth.header.length === 0) {
      throw new Error("invalid workflow webhook header: header is required");
    }
    if (trigger.auth.timestamp && trigger.auth.timestamp.toleranceMs <= 0) {
      throw new Error("invalid workflow webhook timestamp tolerance: must be positive");
    }
  }
};

export const webhook = (config: { path: string; auth: WebhookAuth }): WorkflowTrigger => ({
  type: "webhook",
  path: config.path,
  auth: config.auth,
});

export const cron = (expression: string): WorkflowTrigger => ({
  type: "cron",
  cron: expression,
});

export const hmacSha256 = (config: RawHmacSha256WebhookAuthConfig): WebhookAuth => {
  const base = {
    type: "raw-hmac-sha256" as const,
    header: config.header,
    secret: config.secret,
  };
  const prefixed = config.prefix ? { ...base, prefix: config.prefix } : base;
  return config.timestamp
    ? {
        ...prefixed,
        timestamp: {
          source: config.timestamp.source ?? "body",
          field: config.timestamp.field,
          toleranceMs: config.timestamp.toleranceMs,
        },
      }
    : prefixed;
};
