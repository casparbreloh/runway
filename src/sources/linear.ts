import { Effect, Schema } from "effect";

import { type JobSpec, LinearWebhook, parseRepo } from "../domain.ts";
import { Store } from "../store.ts";
import type { Source, SourceConfig } from "./source.ts";

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const verifyLinearSignature = (
  rawBody: ArrayBuffer,
  signature: string,
  secret: string,
): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, rawBody);
    return constantTimeEqual(toHex(mac), signature);
  });

export const isFreshTimestamp = (
  webhookTimestamp: number,
  nowMs: number,
  toleranceMs = 60_000,
): boolean => Math.abs(nowMs - webhookTimestamp) <= toleranceMs;

export const decodeWebhook = (u: unknown): Effect.Effect<LinearWebhook, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(LinearWebhook)(u);

const asString = (u: unknown): string | undefined => (typeof u === "string" ? u : undefined);

const asRecord = (u: unknown): Record<string, unknown> | undefined =>
  typeof u === "object" && u !== null ? (u as Record<string, unknown>) : undefined;

const pickAgent = (
  text: string,
  fallback: SourceConfig["defaultAgent"],
): SourceConfig["defaultAgent"] => {
  const lower = text.toLowerCase();
  if (lower.includes("codex")) return "codex";
  if (/\bpi\b/.test(lower)) return "pi";
  return fallback;
};

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

interface Trigger {
  readonly plan: string;
  readonly ref: string | undefined;
  readonly title: string | undefined;
  readonly description: string;
}

const issueTrigger = (
  data: Record<string, unknown>,
  action: string,
  config: SourceConfig,
): Trigger | null => {
  if (action !== "create" && action !== "update") return null;
  const state = asRecord(data["state"]);
  if (config.triggerState && asString(state?.["name"]) !== config.triggerState) return null;
  const title = asString(data["title"]);
  const description = asString(data["description"]) ?? "";
  const plan = [title, description].filter(Boolean).join("\n\n");
  return { plan, ref: asString(data["identifier"]), title, description };
};

const commentTrigger = (
  data: Record<string, unknown>,
  action: string,
  config: SourceConfig,
): Trigger | null => {
  if (action !== "create" || !config.triggerComment) return null;
  const body = asString(data["body"]) ?? "";
  if (!body.trim().startsWith(config.triggerComment)) return null;
  const lines = body.split("\n");
  const rest = lines.slice(1).join("\n").trim();
  const plan = rest || body;
  const issue = asRecord(data["issue"]);
  return {
    plan,
    ref: asString(issue?.["identifier"]),
    title: asString(issue?.["title"]),
    description: asString(issue?.["description"]) ?? "",
  };
};

const REPO_LINE = /^repo:\s*(\S+\/\S+)/im;

const resolveRepo = (
  description: string,
  ref: string | undefined,
  config: SourceConfig,
): Effect.Effect<JobSpec["repo"] | null, never, Store> =>
  Effect.gen(function* () {
    const fromDescription = REPO_LINE.exec(description)?.[1];
    if (fromDescription) {
      try {
        return parseRepo(fromDescription);
      } catch {
        return null;
      }
    }

    if (config.workspace && ref) {
      const key = ref.split("-")[0];
      if (key) {
        const store = yield* Store;
        const mapped = yield* store
          .resolveRepo(config.workspace, key)
          .pipe(Effect.orElseSucceed(() => null));
        if (mapped) return mapped;
      }
    }

    if (config.defaultRepo) {
      try {
        return parseRepo(config.defaultRepo);
      } catch {
        return null;
      }
    }

    return null;
  });

export const linearSource: Source = {
  name: "linear",
  toJobSpec: (input, config) =>
    Effect.gen(function* () {
      let payload: LinearWebhook;
      try {
        payload = Schema.decodeUnknownSync(LinearWebhook)(input);
      } catch {
        return null;
      }

      const trigger =
        payload.type === "Issue"
          ? issueTrigger(payload.data, payload.action, config)
          : payload.type === "Comment"
            ? commentTrigger(payload.data, payload.action, config)
            : null;
      if (!trigger) return null;

      const repo = yield* resolveRepo(trigger.description, trigger.ref, config);
      if (!repo) return null;

      const slug = slugify(trigger.ref ?? trigger.title ?? trigger.plan);
      if (!slug) return null;

      const agent = pickAgent(`${trigger.title ?? ""} ${trigger.plan}`, config.defaultAgent);

      const spec: JobSpec = {
        id: `linear-${slug}`,
        repo,
        branch: `runway/${slug}`,
        plan: trigger.plan,
        agent,
        base: config.defaultBase,
        source: { type: "linear", ...(trigger.ref ? { ref: trigger.ref } : {}) },
        ...(trigger.title ? { title: trigger.title } : {}),
      };
      return spec;
    }),
};
