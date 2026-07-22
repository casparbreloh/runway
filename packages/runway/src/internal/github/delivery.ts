import type {
  GitHubEventFilter,
  GitHubPullRequestEvent,
  GitHubPushEvent,
  GitHubRepository,
} from "../../trigger.ts";
import { concatBytes } from "./byte.ts";
import { validGitHubRepository } from "./repository.ts";

export interface GitHubDeliveryConfig {
  readonly repository: GitHubRepository;
  readonly installationId: number;
  readonly webhookSecret: string;
  readonly events: readonly GitHubEventFilter[];
}

export type GitHubWebhookConfig = Omit<GitHubDeliveryConfig, "events">;

export interface GitHubAcceptedDelivery {
  readonly status: "accepted";
  readonly deliveryId: string;
  readonly installationId: number;
  readonly checkRepository: GitHubRepository;
  readonly checkoutRepository: GitHubRepository;
  readonly defaultRef: string;
  readonly event: GitHubPushEvent | GitHubPullRequestEvent;
  readonly concurrency:
    | { readonly type: "push"; readonly repositoryId: number; readonly ref: string }
    | { readonly type: "pull_request"; readonly repositoryId: number; readonly number: number };
}

export interface GitHubSkippedDelivery {
  readonly status: "skipped";
  readonly deliveryId: string;
}

export type GitHubDelivery = GitHubAcceptedDelivery | GitHubSkippedDelivery;

export const GITHUB_WEBHOOK_MAX_BYTES = 1024 * 1024;

const bytesOfHex = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
};

const verifySignature = async (
  bytes: Uint8Array,
  signature: string | null,
  secret: string,
): Promise<boolean> => {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature ?? "");
  if (!match) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  return equalBytes(digest, bytesOfHex(match[1]!));
};

const readGitHubWebhookBody = async (request: Request): Promise<Uint8Array> => {
  const contentLengthHeader = request.headers.get("content-length");
  let contentLength: number | undefined;
  if (contentLengthHeader !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLengthHeader)) {
      throw new Error("invalid GitHub webhook content length");
    }
    contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength)) {
      throw new Error("invalid GitHub webhook content length");
    }
    if (contentLength > GITHUB_WEBHOOK_MAX_BYTES) {
      throw new Error("GitHub webhook body exceeds size limit");
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > GITHUB_WEBHOOK_MAX_BYTES) {
        await reader.cancel();
        throw new Error("GitHub webhook body exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (contentLength !== undefined && contentLength !== total) {
    throw new Error("invalid GitHub webhook content length");
  }
  return concatBytes(...chunks);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const REF_PART = /^(?![./])(?!.*(?:\.\.|\/\/|@\{|\\|[~^:?*[]))(?!.*\.$).+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const parseRepository = (value: unknown, label: string): GitHubRepository => {
  if (!isRecord(value)) throw new Error(`invalid GitHub ${label} payload`);
  const { id, name, full_name: fullName } = value;
  const repository = { id, name, fullName };
  if (!validGitHubRepository(repository)) {
    throw new Error(`invalid GitHub ${label} payload`);
  }
  return repository;
};

const parseDefaultRef = (value: unknown, label: string): string => {
  if (
    !isRecord(value) ||
    typeof value.default_branch !== "string" ||
    !REF_PART.test(value.default_branch)
  ) {
    throw new Error(`invalid GitHub ${label} payload`);
  }
  return `refs/heads/${value.default_branch}`;
};

const sameRepository = (left: GitHubRepository, right: GitHubRepository): boolean =>
  left.id === right.id && left.fullName === right.fullName;

const parseInstallationId = (value: unknown, label: string): number => {
  if (!isRecord(value) || !positiveInteger(value.id)) {
    throw new Error(`invalid GitHub ${label} payload`);
  }
  return value.id;
};

const decodeJson = (body: Uint8Array): unknown => {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    ) as unknown;
  } catch {
    throw new Error("invalid GitHub webhook JSON");
  }
};

export const normalizeGitHubDelivery = async (
  request: Request,
  config: GitHubWebhookConfig,
): Promise<GitHubDelivery> => {
  const body = await readGitHubWebhookBody(request);
  const valid = await verifySignature(
    body,
    request.headers.get("x-hub-signature-256"),
    config.webhookSecret,
  );
  if (!valid) throw new Error("invalid GitHub webhook signature");
  const deliveryId = request.headers.get("x-github-delivery");
  if (!deliveryId || !UUID.test(deliveryId)) {
    throw new Error("invalid GitHub delivery id");
  }
  const eventType = request.headers.get("x-github-event");
  if (!eventType) throw new Error("missing GitHub event header");
  const payload = decodeJson(body);

  if (eventType === "push") {
    if (!isRecord(payload)) throw new Error("invalid GitHub push payload");
    const payloadRepository = parseRepository(payload.repository, "push");
    const installationId = parseInstallationId(payload.installation, "push");
    if (
      typeof payload.ref !== "string" ||
      !payload.ref.startsWith("refs/heads/") ||
      !REF_PART.test(payload.ref.slice("refs/heads/".length)) ||
      typeof payload.deleted !== "boolean" ||
      typeof payload.after !== "string" ||
      !SHA.test(payload.after)
    ) {
      throw new Error("invalid GitHub push payload");
    }
    if (
      !sameRepository(payloadRepository, config.repository) ||
      installationId !== config.installationId ||
      payload.deleted ||
      /^0{40}$/.test(payload.after)
    ) {
      return { status: "skipped", deliveryId };
    }
    return {
      status: "accepted",
      deliveryId,
      installationId,
      checkRepository: config.repository,
      checkoutRepository: config.repository,
      defaultRef: parseDefaultRef(payload.repository, "push"),
      event: {
        type: "push",
        repository: config.repository,
        ref: payload.ref,
        sha: payload.after,
      },
      concurrency: { type: "push", repositoryId: config.repository.id, ref: payload.ref },
    };
  }

  if (eventType === "pull_request") {
    if (!isRecord(payload)) throw new Error("invalid GitHub pull request payload");
    const baseRepository = parseRepository(payload.repository, "pull request");
    const installationId = parseInstallationId(payload.installation, "pull request");
    if (
      typeof payload.action !== "string" ||
      !isRecord(payload.pull_request) ||
      !positiveInteger(payload.number) ||
      !isRecord(payload.pull_request.base) ||
      !isRecord(payload.pull_request.head)
    ) {
      throw new Error("invalid GitHub pull request payload");
    }
    const prBaseRepository = parseRepository(
      payload.pull_request.base.repo,
      "pull request base repository",
    );
    const headRepository = parseRepository(
      payload.pull_request.head.repo,
      "pull request head repository",
    );
    const headRef = payload.pull_request.head.ref;
    const headSha = payload.pull_request.head.sha;
    if (
      typeof headRef !== "string" ||
      !REF_PART.test(headRef) ||
      typeof headSha !== "string" ||
      !SHA.test(headSha)
    ) {
      throw new Error("invalid GitHub pull request payload");
    }
    if (
      !sameRepository(baseRepository, config.repository) ||
      installationId !== config.installationId ||
      !sameRepository(prBaseRepository, config.repository) ||
      !sameRepository(baseRepository, prBaseRepository) ||
      !["opened", "reopened", "synchronize"].includes(payload.action)
    ) {
      return { status: "skipped", deliveryId };
    }
    const action = payload.action as GitHubPullRequestEvent["action"];
    return {
      status: "accepted",
      deliveryId,
      installationId,
      checkRepository: config.repository,
      checkoutRepository: headRepository,
      defaultRef: parseDefaultRef(payload.repository, "pull request"),
      event: {
        type: "pull_request",
        action,
        repository: config.repository,
        number: payload.number,
        ref: headRef,
        sha: headSha,
      },
      concurrency: {
        type: "pull_request",
        repositoryId: config.repository.id,
        number: payload.number,
      },
    };
  }

  return { status: "skipped", deliveryId };
};

export const matchGitHubDelivery = (
  delivery: GitHubDelivery,
  events: readonly GitHubEventFilter[],
): GitHubDelivery => {
  if (delivery.status === "skipped") return delivery;
  if (delivery.event.type === "push") {
    const push = delivery.event;
    const matched = events.some(
      (event) =>
        event.type === "push" &&
        event.branches.some((branch) => push.ref === `refs/heads/${branch}`),
    );
    return matched ? delivery : { status: "skipped", deliveryId: delivery.deliveryId };
  }
  const pullRequest = delivery.event;
  const matched = events.some(
    (event) => event.type === "pull_request" && event.actions.includes(pullRequest.action),
  );
  return matched ? delivery : { status: "skipped", deliveryId: delivery.deliveryId };
};

export const parseGitHubDelivery = async (
  request: Request,
  config: GitHubDeliveryConfig,
): Promise<GitHubDelivery> =>
  matchGitHubDelivery(await normalizeGitHubDelivery(request, config), config.events);
