import type {
  CronTrigger,
  WebhookAuth,
  WebhookTimestamp,
  WebhookTrigger,
  WorkflowTrigger,
} from "@runway/core";

interface WorkflowBinding {
  create(opts: { params: unknown }): Promise<{ id: string }>;
}

type RouterEnv = Record<string, string | WorkflowBinding | undefined>;

export interface RouterEntry {
  readonly binding: string;
  readonly trigger: WorkflowTrigger;
}

export interface Router {
  fetch(req: Request, env: unknown): Promise<Response>;
  scheduled(
    event: { readonly cron: string; readonly scheduledTime: number },
    env: unknown,
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

export const hmacSha256Hex = async (secret: string, body: string): Promise<string> => {
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
  auth: WebhookAuth,
  secret: string,
  signature: string,
  body: string,
): Promise<boolean> => {
  let actual = signature;
  if (auth.prefix) {
    if (!signature.toLowerCase().startsWith(auth.prefix.toLowerCase())) return false;
    actual = signature.slice(auth.prefix.length);
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

export const createRouter = (entries: ReadonlyArray<RouterEntry>): Router => {
  const webhooks = entries.filter(
    (entry): entry is RouterEntry & { trigger: WebhookTrigger } => entry.trigger.type === "webhook",
  );
  const crons = entries.filter(
    (entry): entry is RouterEntry & { trigger: CronTrigger } => entry.trigger.type === "cron",
  );
  return {
    async fetch(req, env) {
      const pathname = new URL(req.url).pathname;
      const entry =
        req.method === "POST"
          ? webhooks.find((webhook) => webhook.trigger.path === pathname)
          : undefined;
      if (!entry) return new Response("not found", { status: 404 });
      const auth = entry.trigger.auth;
      const secret = (env as RouterEnv)[auth.secret];
      if (typeof secret !== "string") {
        return new Response(`no secret: ${auth.secret}`, { status: 500 });
      }
      const body = await req.text();
      const signature = req.headers.get(auth.header);
      if (!signature || !(await verifySignature(auth, secret, signature, body))) {
        return new Response("unauthorized", { status: 401 });
      }
      let params: unknown;
      try {
        params = body.length > 0 ? JSON.parse(body) : {};
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      if (auth.timestamp && !verifyTimestamp(auth.timestamp, params, req.headers)) {
        return new Response("unauthorized", { status: 401 });
      }
      const workflow = (env as RouterEnv)[entry.binding];
      if (typeof workflow !== "object" || !workflow) {
        return new Response(`no binding: ${entry.binding}`, { status: 500 });
      }
      const instance = await workflow.create({ params });
      return Response.json({ id: instance.id }, { status: 202 });
    },
    async scheduled(event, env) {
      await Promise.all(
        crons
          .filter((entry) => entry.trigger.cron === event.cron)
          .map((entry) => {
            const workflow = (env as RouterEnv)[entry.binding];
            if (typeof workflow !== "object" || !workflow) {
              throw new Error(`no binding: ${entry.binding}`);
            }
            return workflow.create({
              params: { cron: event.cron, scheduledTime: event.scheduledTime },
            });
          }),
      );
    },
  };
};
