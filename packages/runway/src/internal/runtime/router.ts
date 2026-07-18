import { secretNameOf } from "../../secret.ts";
import type { CronTrigger, WebhookTimestamp, WebhookTrigger } from "../../trigger.ts";
import type { WorkflowTrigger } from "../../workflow.ts";

interface WorkflowBinding {
  create(opts: { params: unknown }): Promise<{ id: string }>;
}

type RouterEnv = Record<string, string | WorkflowBinding | undefined>;

export interface RouterEntry {
  readonly id: string;
  readonly binding?: string;
  readonly trigger: WorkflowTrigger;
}

export type WebhookRouterEntry = RouterEntry & { readonly trigger: WebhookTrigger<unknown> };

export interface PassedWebhookGate {
  readonly status: "passed";
  readonly entry: WebhookRouterEntry;
  readonly event: unknown;
}

export type SkippedWebhookGate =
  | {
      readonly status: "skipped";
      readonly entry: WebhookRouterEntry;
      readonly reason: "schema";
    }
  | {
      readonly status: "skipped";
      readonly entry: WebhookRouterEntry;
      readonly reason: "filter";
      readonly event: unknown;
    };

export type WebhookGateDecision = PassedWebhookGate | SkippedWebhookGate;

export type WebhookGateEvaluation =
  | {
      readonly status: "ok";
      readonly decisions: ReadonlyArray<WebhookGateDecision>;
    }
  | {
      readonly status: "error";
      readonly error: unknown;
    };

export interface WorkflowStarter {
  start(entry: RouterEntry, event: unknown, env: unknown, ctx?: unknown): Promise<{ id: string }>;
}

export interface Router {
  fetch(req: Request, env: unknown, ctx?: unknown): Promise<Response>;
  scheduled(
    event: { readonly cron: string; readonly scheduledTime: number },
    env: unknown,
    ctx?: unknown,
  ): Promise<void>;
}

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

const timingSafeEqual = (left: string, right: string): boolean => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
};

const hmacSha256Hex = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return hex(signature);
};

const verifySignature = async (
  trigger: WebhookTrigger<unknown>,
  secret: string,
  signature: string,
  body: string,
): Promise<boolean> => {
  let actual = signature;
  if (trigger.prefix) {
    if (!signature.toLowerCase().startsWith(trigger.prefix.toLowerCase())) return false;
    actual = signature.slice(trigger.prefix.length);
  }
  return timingSafeEqual(await hmacSha256Hex(secret, body), actual);
};

const timestampOf = (timestamp: WebhookTimestamp, params: unknown, headers: Headers): number => {
  if (timestamp.source === "header") return Number(headers.get(timestamp.field));
  const value =
    params && typeof params === "object"
      ? (params as Record<string, unknown>)[timestamp.field]
      : undefined;
  return typeof value === "number" ? value : Number.NaN;
};

const verifyTimestamp = (
  timestamp: WebhookTimestamp,
  params: unknown,
  headers: Headers,
): boolean => {
  const value = timestampOf(timestamp, params, headers);
  if (!Number.isFinite(value) || value <= 0) return false;
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  return Math.abs(Date.now() - ms) <= timestamp.toleranceMs;
};

const passedWebhookGate = (decision: WebhookGateDecision): decision is PassedWebhookGate =>
  decision.status === "passed";

const evaluateWebhookGates = async (
  entries: ReadonlyArray<WebhookRouterEntry>,
  params: unknown,
): Promise<WebhookGateEvaluation> => {
  const decisions: WebhookGateDecision[] = [];
  try {
    for (const entry of entries) {
      let event = params;
      if (entry.trigger.schema) {
        const result = await entry.trigger.schema["~standard"].validate(params);
        if (result.issues) {
          decisions.push({ status: "skipped", entry, reason: "schema" });
          continue;
        }
        event = result.value;
      }
      if (entry.trigger.predicate && !entry.trigger.predicate(event)) {
        decisions.push({ status: "skipped", entry, reason: "filter", event });
        continue;
      }
      decisions.push({ status: "passed", entry, event });
    }
  } catch (error) {
    return { status: "error", error };
  }
  return { status: "ok", decisions };
};

const bindingStarter: WorkflowStarter = {
  async start(entry, event, env) {
    const binding = entry.binding ?? entry.id;
    const workflow = (env as RouterEnv)[binding];
    if (typeof workflow !== "object" || !workflow) {
      throw new Error(`no binding: ${binding}`);
    }
    return await workflow.create({ params: event });
  },
};

export const createRouter = (
  entries: ReadonlyArray<RouterEntry>,
  starter: WorkflowStarter = bindingStarter,
): Router => {
  const webhooks = entries.filter(
    (entry): entry is WebhookRouterEntry => entry.trigger.type === "webhook",
  );
  const crons = entries.filter(
    (entry): entry is RouterEntry & { trigger: CronTrigger } => entry.trigger.type === "cron",
  );
  return {
    async fetch(req, env, ctx) {
      const pathname = new URL(req.url).pathname;
      const matches =
        req.method === "POST"
          ? webhooks.filter((webhook) => webhook.trigger.path === pathname)
          : [];
      const first = matches[0];
      if (!first) return new Response("not found", { status: 404 });
      const trigger = first.trigger;
      const secretName = secretNameOf(trigger.secret);
      const secret = (env as RouterEnv)[secretName];
      if (typeof secret !== "string") {
        return new Response(`no secret: ${secretName}`, { status: 500 });
      }
      const body = await req.text();
      const signature = req.headers.get(trigger.signatureHeader);
      if (!signature || !(await verifySignature(trigger, secret, signature, body))) {
        return new Response("unauthorized", { status: 401 });
      }
      let params: unknown;
      try {
        params = body.length > 0 ? JSON.parse(body) : {};
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      if (trigger.timestamp && !verifyTimestamp(trigger.timestamp, params, req.headers)) {
        return new Response("unauthorized", { status: 401 });
      }
      const evaluation = await evaluateWebhookGates(matches, params);
      if (evaluation.status === "error") {
        return new Response("trigger evaluation failed", { status: 500 });
      }
      const passing = evaluation.decisions.filter(passedWebhookGate);
      if (passing.length === 0) return Response.json({ skipped: true });
      const runs: Array<{ id: string; workflow: string }> = [];
      for (const { entry, event } of passing) {
        const instance = await starter.start(entry, event, env, ctx);
        runs.push({ id: instance.id, workflow: entry.id });
      }
      return Response.json({ runs }, { status: 202 });
    },
    async scheduled(event, env, ctx) {
      await Promise.all(
        crons
          .filter((entry) => entry.trigger.expression === event.cron)
          .map((entry) =>
            starter.start(
              entry,
              { cron: event.cron, scheduledTime: event.scheduledTime },
              env,
              ctx,
            ),
          ),
      );
    },
  };
};
