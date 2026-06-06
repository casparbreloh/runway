// Linear webhook verification + decode + mapping to a JobSpec.
import { Effect, Schema } from "effect";
import {
  type Executor,
  type JobSpec,
  LinearCommentData,
  LinearIssueData,
  LinearWebhook,
  parseRepo,
  ValidationError,
} from "./domain.ts";

const decodeIssueData = Schema.decodeUnknownSync(LinearIssueData);
const decodeCommentData = Schema.decodeUnknownSync(LinearCommentData);

/** Decode the top-level webhook envelope; `data` stays loose. */
export const decodeWebhook: (u: unknown) => Effect.Effect<LinearWebhook, Schema.SchemaError> =
  Schema.decodeUnknownEffect(LinearWebhook);

/** Lowercase hex HMAC-SHA256 of the raw body bytes with `secret`. */
const hmacHex = (rawBody: ArrayBuffer, secret: string): Promise<string> =>
  crypto.subtle
    .importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((key) => crypto.subtle.sign("HMAC", key, rawBody))
    .then((mac) =>
      Array.from(new Uint8Array(mac))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    );

/** Constant-time compare of two equal-length strings; false on length mismatch. */
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Verify the hex HMAC-SHA256 signature of the raw body bytes. */
export const verifyLinearSignature = (
  rawBody: ArrayBuffer,
  signature: string,
  secret: string,
): Effect.Effect<boolean> =>
  Effect.promise(async () => constantTimeEqual(await hmacHex(rawBody, secret), signature));

/** True when the webhook timestamp is within `toleranceMs` of `nowMs`. */
export const isFreshTimestamp = (webhookTimestamp: number, nowMs: number, toleranceMs = 60_000): boolean =>
  Math.abs(nowMs - webhookTimestamp) <= toleranceMs;

export interface LinearConfig {
  readonly defaultRepo?: string;
  readonly defaultExecutor: Executor;
  readonly defaultBase: string;
  readonly triggerState?: string;
  readonly triggerComment?: string;
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Pick executor from free text: explicit "codex" wins, then a standalone "pi" token, else the default. */
const pickExecutor = (text: string, fallback: Executor): Executor => {
  if (/codex/i.test(text)) return "codex-cloud";
  if (/\bpi\b/i.test(text)) return "pi";
  return fallback;
};

/** A `repo: owner/name` line in the issue description overrides the configured default. */
const repoSlugFor = (description: string, config: LinearConfig): string | undefined => {
  const match = description.match(/^repo:\s*(\S+\/\S+)/im);
  return match ? match[1] : config.defaultRepo;
};

/** Resolve the repo slug to a Repo; null when missing or `parseRepo` rejects it. */
const resolveRepo = (slug: string | undefined): JobSpec["repo"] | null => {
  if (!slug) return null;
  try {
    return parseRepo(slug);
  } catch {
    return null;
  }
};

interface Trigger {
  readonly plan: string;
  readonly title: string | undefined;
  readonly ref: string | undefined;
  readonly description: string;
  readonly executorText: string; // free text scanned for an executor keyword (incl. the command line)
}

/** Detect an issue trigger (create/update, optionally gated on state name). */
const issueTrigger = (payload: LinearWebhook, config: LinearConfig): Trigger | null => {
  if (payload.type !== "Issue") return null;
  if (payload.action !== "create" && payload.action !== "update") return null;
  let data;
  try {
    data = decodeIssueData(payload.data);
  } catch {
    return null;
  }
  if (config.triggerState && data.state?.name !== config.triggerState) return null;
  const title = data.title;
  const description = data.description ?? "";
  const plan = [title, description].filter(Boolean).join("\n\n");
  return { plan, title, ref: data.identifier, description, executorText: plan };
};

/** Detect a comment trigger: action create, body starts with the configured command prefix. */
const commentTrigger = (payload: LinearWebhook, config: LinearConfig): Trigger | null => {
  if (payload.type !== "Comment" || payload.action !== "create") return null;
  if (!config.triggerComment) return null;
  let data;
  try {
    data = decodeCommentData(payload.data);
  } catch {
    return null;
  }
  const body = data.body ?? "";
  if (!body.trim().startsWith(config.triggerComment)) return null;
  const lines = body.split("\n");
  const rest = lines.slice(1).join("\n").trim();
  const plan = rest || body;
  const issue = data.issue;
  const description = issue?.description ?? "";
  return { plan, title: issue?.title, ref: issue?.identifier, description, executorText: body };
};

/**
 * Map a webhook to a JobSpec, or null when it is not a trigger / the repo can't be resolved.
 * Reads `payload.data` defensively via the domain Schemas.
 */
export const eventToJobSpec = (
  payload: LinearWebhook,
  config: LinearConfig,
): Effect.Effect<JobSpec | null, ValidationError> =>
  Effect.sync(() => {
    const trigger = issueTrigger(payload, config) ?? commentTrigger(payload, config);
    if (!trigger) return null;

    const repo = resolveRepo(repoSlugFor(trigger.description, config));
    if (!repo) return null;

    const executor = pickExecutor(`${trigger.title ?? ""}\n${trigger.executorText}`, config.defaultExecutor);

    const slug = slugify(trigger.ref ?? trigger.title ?? trigger.plan);
    if (!slug) return null;

    const source: NonNullable<JobSpec["source"]> = trigger.ref
      ? { type: "linear", ref: trigger.ref }
      : { type: "linear" };

    const spec: JobSpec = {
      id: `linear-${slug}`,
      repo,
      branch: `runway/${slug}`,
      plan: trigger.plan,
      executor,
      base: config.defaultBase,
      source,
      ...(trigger.title ? { title: trigger.title } : {}),
    };
    return spec;
  });
