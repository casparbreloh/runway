import type { HmacSha256Options, WebhookAuth, WebhookOptions, WorkflowTrigger } from "./types.ts";

const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export const webhook = (options: WebhookOptions): WorkflowTrigger => ({
  type: "webhook",
  ...options,
});

export const cron = (expression: string): WorkflowTrigger => ({
  type: "cron",
  cron: expression,
});

export const hmacSha256 = (options: HmacSha256Options): WebhookAuth => ({
  type: "raw-hmac-sha256",
  header: options.header,
  secret: options.secret,
  ...(options.prefix ? { prefix: options.prefix } : {}),
  ...(options.timestamp
    ? { timestamp: { ...options.timestamp, source: options.timestamp.source ?? "body" } }
    : {}),
});
