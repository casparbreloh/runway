import type { WebhookAuth } from "@runway/core";

interface WorkflowBinding {
  create(opts: { params: unknown }): Promise<{ id: string }>;
}

type RouterEntry = {
  readonly id: string;
  readonly binding: string;
  readonly trigger:
    | { readonly type: "webhook"; readonly path: string; readonly auth: WebhookAuth }
    | { readonly type: "cron"; readonly cron: string };
};

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

const same = (left: string, right: string): boolean => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const hmacSha256 = async (secret: string, body: string): Promise<string> => {
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

const timestampFromBody = (params: unknown, field: string): number | undefined => {
  const value =
    params && typeof params === "object" ? (params as Record<string, unknown>)[field] : undefined;
  return typeof value === "number" ? value : undefined;
};

const timestampFromHeader = (headers: Headers, field: string): number | undefined => {
  const value = headers.get(field);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const verifyTimestamp = (timestamp: number | undefined, toleranceMs: number): boolean => {
  if (!timestamp) return false;
  const millis = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  return Math.abs(Date.now() - millis) <= toleranceMs;
};

export const createRouter = (
  entries: ReadonlyArray<RouterEntry>,
): {
  fetch(req: Request, env: unknown): Promise<Response>;
  scheduled(
    event: { readonly cron: string; readonly scheduledTime: number },
    env: unknown,
  ): Promise<void>;
} => ({
  async fetch(req, env) {
    const pathname = new URL(req.url).pathname;
    const entry = entries.find((e) => {
      if (e.trigger.type === "cron") return false;
      return e.trigger.path === pathname && req.method === "POST";
    });
    if (!entry) return new Response("not found", { status: 404 });
    if (entry.trigger.type !== "webhook") return new Response("not found", { status: 404 });
    const raw = await req.text();
    const secret = (env as Record<string, string | undefined>)[entry.trigger.auth.secret];
    if (!secret) return new Response(`no secret: ${entry.trigger.auth.secret}`, { status: 500 });
    const auth = entry.trigger.auth;
    const signature = req.headers.get(auth.header);
    if (!signature) return new Response("unauthorized", { status: 401 });
    const expected = await hmacSha256(secret, raw);
    if (auth.prefix && !signature.toLowerCase().startsWith(auth.prefix.toLowerCase())) {
      return new Response("unauthorized", { status: 401 });
    }
    const actual = auth.prefix
      ? signature.replace(new RegExp(`^${escapeRegExp(auth.prefix)}`, "i"), "")
      : signature;
    if (!same(expected, actual)) {
      return new Response("unauthorized", { status: 401 });
    }
    let params: unknown;
    try {
      params = raw.length > 0 ? JSON.parse(raw) : {};
    } catch {
      return new Response("invalid json", { status: 400 });
    }
    if (auth.timestamp) {
      const sentAt =
        auth.timestamp.source === "body"
          ? timestampFromBody(params, auth.timestamp.field)
          : timestampFromHeader(req.headers, auth.timestamp.field);
      if (!verifyTimestamp(sentAt, auth.timestamp.toleranceMs)) {
        return new Response("unauthorized", { status: 401 });
      }
    }
    const wf = (env as Record<string, WorkflowBinding | undefined>)[entry.binding];
    if (!wf) return new Response(`no binding: ${entry.binding}`, { status: 500 });
    const instance = await wf.create({ params });
    return Response.json({ id: instance.id }, { status: 202 });
  },
  async scheduled(event, env) {
    await Promise.all(
      entries
        .filter((e) => e.trigger.type === "cron" && e.trigger.cron === event.cron)
        .map((entry) => {
          const wf = (env as Record<string, WorkflowBinding | undefined>)[entry.binding];
          if (!wf) throw new Error(`no binding: ${entry.binding}`);
          return wf.create({ params: { cron: event.cron, scheduledTime: event.scheduledTime } });
        }),
    );
  },
});
