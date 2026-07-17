import type { Trigger } from "./trigger.ts";

export interface GitHubRepository {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
}

export interface GitHubPushEvent {
  readonly type: "push";
  readonly repository: GitHubRepository;
  readonly ref: string;
  readonly sha: string;
}

export type GitHubPullRequestAction = "opened" | "reopened" | "synchronize";

export interface GitHubPullRequestEvent<
  A extends GitHubPullRequestAction = GitHubPullRequestAction,
> {
  readonly type: "pull_request";
  readonly action: A;
  readonly repository: GitHubRepository;
  readonly number: number;
  readonly ref: string;
  readonly sha: string;
}

export interface GitHubPushFilter {
  readonly type: "push";
  readonly branches: readonly [string, ...string[]];
}

export interface GitHubPullRequestFilter<
  A extends readonly [GitHubPullRequestAction, ...GitHubPullRequestAction[]] = readonly [
    GitHubPullRequestAction,
    ...GitHubPullRequestAction[],
  ],
> {
  readonly type: "pull_request";
  readonly actions: A;
}

export type GitHubEventFilter = GitHubPushFilter | GitHubPullRequestFilter;

export type GitHubEventOf<F extends GitHubEventFilter> = F extends GitHubPushFilter
  ? GitHubPushEvent
  : F extends GitHubPullRequestFilter<infer A>
    ? GitHubPullRequestEvent<A[number]>
    : never;

export interface GitHubOptions<F extends readonly [GitHubEventFilter, ...GitHubEventFilter[]]> {
  readonly checkName: string;
  readonly events: F;
}

export interface GitHubTrigger<E> extends Trigger<E> {
  readonly type: "github";
  readonly checkName: string;
  readonly events: readonly GitHubEventFilter[];
}

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
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const REF_PART = /^(?![./])(?!.*(?:\.\.|\/\/|@\{|\\|[~^:?*[]))(?!.*\.$).+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const parseRepository = (value: unknown, label: string): GitHubRepository => {
  if (!isRecord(value)) throw new Error(`invalid GitHub ${label} payload`);
  const { id, name, full_name: fullName } = value;
  if (
    !positiveInteger(id) ||
    typeof name !== "string" ||
    !REPOSITORY_PART.test(name) ||
    typeof fullName !== "string"
  ) {
    throw new Error(`invalid GitHub ${label} payload`);
  }
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !REPOSITORY_PART.test(parts[0]) || parts[1] !== name) {
    throw new Error(`invalid GitHub ${label} payload`);
  }
  return { id, name, fullName };
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

export type GitHubTokenPurpose = "checkout" | "checks";

export interface GitHubProviderOptions {
  readonly appId: string;
  readonly privateKey: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface GitHubInstallationToken {
  readonly token: string;
  readonly expiresAt: string;
}

export class GitHubRepositoryUnavailableError extends Error {
  readonly installationId: number;
  readonly repositoryId: number;

  constructor(installationId: number, repositoryId: number) {
    super("GitHub repository is unavailable to the installation");
    this.name = "GitHubRepositoryUnavailableError";
    this.installationId = installationId;
    this.repositoryId = repositoryId;
  }
}

export type GitHubCheckConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure"
  | "success"
  | "timed_out";

export interface GitHubCheckRun {
  readonly id: number;
  readonly name: string;
  readonly headSha: string;
  readonly externalId: string | null;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion: GitHubCheckConclusion | null;
}

export interface GitHubCheckOutput {
  readonly title: string;
  readonly summary: string;
}

interface GitHubCheckIdentity {
  readonly token: string;
  readonly repository: GitHubRepository;
}

export interface GitHubProvider {
  resolveRepository(fullName: string): Promise<{
    readonly installationId: number;
    readonly repository: GitHubRepository;
  }>;
  createInstallationToken(options: {
    readonly installationId: number;
    readonly repository: GitHubRepository;
    readonly purpose: GitHubTokenPurpose;
  }): Promise<GitHubInstallationToken>;
  createQueuedCheck(
    options: GitHubCheckIdentity & {
      readonly name: string;
      readonly headSha: string;
      readonly runId: string;
    },
  ): Promise<GitHubCheckRun>;
  reconcileCheck(
    options: GitHubCheckIdentity & {
      readonly name: string;
      readonly headSha: string;
      readonly runId: string;
    },
  ): Promise<GitHubCheckRun | undefined>;
  markCheckInProgress(
    options: GitHubCheckIdentity & { readonly checkRunId: number },
  ): Promise<GitHubCheckRun>;
  completeCheck(
    options: GitHubCheckIdentity & {
      readonly checkRunId: number;
      readonly conclusion: "success" | "failure" | "cancelled";
      readonly output?: GitHubCheckOutput;
    },
  ): Promise<GitHubCheckRun>;
}

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const derLength = (length: number): Uint8Array => {
  if (length < 128) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) {
    bytes.unshift(remaining & 0xff);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
};

const derValue = (tag: number, value: Uint8Array): Uint8Array =>
  concatBytes(new Uint8Array([tag]), derLength(value.length), value);

const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array => {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  return derValue(0x30, concatBytes(version, rsaAlgorithm, derValue(0x04, pkcs1)));
};

const bytesFromBase64 = (value: string): Uint8Array => {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

const bytesFromPem = (pem: string): Uint8Array => {
  const pkcs8 =
    /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END PRIVATE KEY-----\s*$/.exec(pem);
  if (pkcs8) return bytesFromBase64(pkcs8[1]!.replace(/\s/g, ""));
  const pkcs1 =
    /^-----BEGIN RSA PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END RSA PRIVATE KEY-----\s*$/.exec(
      pem,
    );
  if (pkcs1) return pkcs1ToPkcs8(bytesFromBase64(pkcs1[1]!.replace(/\s/g, "")));
  throw new Error("invalid GitHub App credentials");
};

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

const jsonBase64Url = (value: unknown): string =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

const createAppJwt = async (appId: string, privateKey: string, now: number): Promise<string> => {
  if (!/^[1-9][0-9]*$/.test(appId) || !Number.isFinite(now)) {
    throw new Error("invalid GitHub App credentials");
  }
  try {
    const seconds = Math.floor(now / 1000);
    const header = jsonBase64Url({ alg: "RS256", typ: "JWT" });
    const payload = jsonBase64Url({ iat: seconds - 60, exp: seconds + 600, iss: appId });
    const content = `${header}.${payload}`;
    const keyBytes = bytesFromPem(privateKey);
    const key = await crypto.subtle.importKey(
      "pkcs8",
      keyBytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(content),
    );
    return `${content}.${base64Url(new Uint8Array(signature))}`;
  } catch {
    throw new Error("invalid GitHub App credentials");
  }
};

const githubHeaders = (authorization: string): Headers =>
  new Headers({
    accept: "application/vnd.github+json",
    authorization,
    "content-type": "application/json",
    "user-agent": "Runway",
    "x-github-api-version": "2022-11-28",
  });

const checkConclusions = new Set<GitHubCheckConclusion>([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);

const parseCheckRun = (value: unknown): GitHubCheckRun => {
  if (!isRecord(value)) throw new Error("invalid GitHub Check response");
  const { id, name, head_sha: headSha, external_id: externalId, status, conclusion } = value;
  if (
    !positiveInteger(id) ||
    typeof name !== "string" ||
    name.length === 0 ||
    typeof headSha !== "string" ||
    !SHA.test(headSha) ||
    (typeof externalId !== "string" && externalId !== null) ||
    (status !== "queued" && status !== "in_progress" && status !== "completed") ||
    (conclusion !== null &&
      (typeof conclusion !== "string" ||
        !checkConclusions.has(conclusion as GitHubCheckConclusion))) ||
    (status !== "completed" && conclusion !== null)
  ) {
    throw new Error("invalid GitHub Check response");
  }
  return {
    id,
    name,
    headSha,
    externalId,
    status,
    conclusion: conclusion as GitHubCheckConclusion | null,
  };
};

const repositoryPath = (repository: GitHubRepository): string => {
  const parts = repository.fullName.split("/");
  if (
    !positiveInteger(repository.id) ||
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !REPOSITORY_PART.test(parts[0]) ||
    !REPOSITORY_PART.test(parts[1]) ||
    parts[1] !== repository.name
  ) {
    throw new Error("invalid GitHub Check request");
  }
  return `${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
};

const repositoryNamePath = (fullName: string): { readonly path: string; readonly name: string } => {
  const parts = fullName.split("/");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !REPOSITORY_PART.test(parts[0]) ||
    !REPOSITORY_PART.test(parts[1])
  ) {
    throw new Error("invalid GitHub repository name");
  }
  return {
    path: `${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`,
    name: parts[1],
  };
};

const checkArguments = (
  token: string,
  repository: GitHubRepository,
): { readonly path: string; readonly headers: Headers } => {
  if (token.length === 0) throw new Error("invalid GitHub Check request");
  return {
    path: repositoryPath(repository),
    headers: githubHeaders(`Bearer ${token}`),
  };
};

export const createGitHubProvider = (options: GitHubProviderOptions): GitHubProvider => {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  const checkRequest = async (url: string, init: RequestInit): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      throw new Error("GitHub Check request failed");
    }
    if (!response.ok) throw new Error(`GitHub Check request failed (${response.status})`);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new Error("invalid GitHub Check response");
    }
  };

  return {
    async resolveRepository(fullName) {
      const { path, name } = repositoryNamePath(fullName);
      let jwt: string;
      try {
        jwt = await createAppJwt(options.appId, options.privateKey, now());
      } catch {
        throw new Error("GitHub repository resolution failed");
      }
      let installationResponse: Response;
      try {
        installationResponse = await fetchImpl(
          `https://api.github.com/repos/${path}/installation`,
          { method: "GET", headers: githubHeaders(`Bearer ${jwt}`) },
        );
      } catch {
        throw new Error("GitHub repository resolution failed");
      }
      if (!installationResponse.ok) {
        throw new Error(`GitHub repository resolution failed (${installationResponse.status})`);
      }
      let installation: unknown;
      try {
        installation = await installationResponse.json();
      } catch {
        throw new Error("invalid GitHub repository installation response");
      }
      if (!isRecord(installation) || !positiveInteger(installation.id)) {
        throw new Error("invalid GitHub repository installation response");
      }
      const installationId = installation.id;
      let tokenResponse: Response;
      try {
        tokenResponse = await fetchImpl(
          `https://api.github.com/app/installations/${installationId}/access_tokens`,
          {
            method: "POST",
            headers: githubHeaders(`Bearer ${jwt}`),
            body: JSON.stringify({
              repositories: [name],
              permissions: { contents: "read" },
            }),
          },
        );
      } catch {
        throw new Error("GitHub repository resolution failed");
      }
      if (!tokenResponse.ok) {
        throw new Error(`GitHub repository resolution failed (${tokenResponse.status})`);
      }
      let value: unknown;
      try {
        value = await tokenResponse.json();
      } catch {
        throw new Error("invalid GitHub installation token response");
      }
      if (!isRecord(value)) throw new Error("invalid GitHub installation token response");
      const { token, expires_at: expiresAt, repositories } = value;
      const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
      const currentTime = now();
      const candidate =
        Array.isArray(repositories) && repositories.length === 1 ? repositories[0] : undefined;
      const candidateName = isRecord(candidate) ? candidate.name : undefined;
      const candidateFullName = isRecord(candidate) ? candidate.full_name : undefined;
      const candidateRepository =
        isRecord(candidate) &&
        positiveInteger(candidate.id) &&
        typeof candidateName === "string" &&
        typeof candidateFullName === "string"
          ? { id: candidate.id, name: candidateName, fullName: candidateFullName }
          : undefined;
      let canonical = false;
      try {
        canonical =
          candidateRepository !== undefined &&
          repositoryPath(candidateRepository).toLowerCase() === path.toLowerCase();
      } catch {
        canonical = false;
      }
      if (
        typeof token !== "string" ||
        token.length === 0 ||
        typeof expiresAt !== "string" ||
        !Number.isFinite(expiresAtMs) ||
        expiresAtMs <= currentTime ||
        expiresAtMs > currentTime + 60 * 60 * 1000 ||
        !canonical ||
        !candidateRepository
      ) {
        throw new Error("invalid GitHub installation token response");
      }
      return {
        installationId,
        repository: candidateRepository,
      };
    },

    async createInstallationToken({ installationId, repository, purpose }) {
      let scopedRepositoryPath: string;
      try {
        scopedRepositoryPath = repositoryPath(repository);
      } catch {
        throw new Error("invalid GitHub installation token request");
      }
      if (!positiveInteger(installationId)) {
        throw new Error("invalid GitHub installation token request");
      }
      let jwt: string;
      try {
        jwt = await createAppJwt(options.appId, options.privateKey, now());
      } catch {
        throw new Error("GitHub installation token request failed");
      }
      let installationResponse: Response;
      try {
        installationResponse = await fetchImpl(
          `https://api.github.com/repos/${scopedRepositoryPath}/installation`,
          { method: "GET", headers: githubHeaders(`Bearer ${jwt}`) },
        );
      } catch {
        throw new Error("GitHub installation token request failed");
      }
      if (installationResponse.status === 404) {
        throw new GitHubRepositoryUnavailableError(installationId, repository.id);
      }
      if (!installationResponse.ok) {
        throw new Error(
          `GitHub installation token request failed (${installationResponse.status})`,
        );
      }
      let installation: unknown;
      try {
        installation = await installationResponse.json();
      } catch {
        throw new Error("invalid GitHub repository installation response");
      }
      if (!isRecord(installation) || installation.id !== installationId) {
        throw new Error("invalid GitHub repository installation response");
      }
      let response: Response;
      try {
        response = await fetchImpl(
          `https://api.github.com/app/installations/${installationId}/access_tokens`,
          {
            method: "POST",
            headers: githubHeaders(`Bearer ${jwt}`),
            body: JSON.stringify({
              repository_ids: [repository.id],
              permissions: purpose === "checkout" ? { contents: "read" } : { checks: "write" },
            }),
          },
        );
      } catch {
        throw new Error("GitHub installation token request failed");
      }
      if (!response.ok) {
        throw new Error(`GitHub installation token request failed (${response.status})`);
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new Error("invalid GitHub installation token response");
      }
      if (!isRecord(value)) throw new Error("invalid GitHub installation token response");
      const { token, expires_at: expiresAt, repositories } = value;
      const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
      const requestedRepositoryGranted =
        Array.isArray(repositories) &&
        repositories.length === 1 &&
        isRecord(repositories[0]) &&
        repositories[0].id === repository.id;
      const currentTime = now();
      if (
        typeof token !== "string" ||
        token.length === 0 ||
        typeof expiresAt !== "string" ||
        !Number.isFinite(expiresAtMs) ||
        expiresAtMs <= currentTime ||
        expiresAtMs > currentTime + 60 * 60 * 1000 ||
        !requestedRepositoryGranted
      ) {
        throw new Error("invalid GitHub installation token response");
      }
      return { token, expiresAt };
    },

    async createQueuedCheck({ token, repository, name, headSha, runId }) {
      const { path, headers } = checkArguments(token, repository);
      if (name.length === 0 || runId.length === 0 || !SHA.test(headSha)) {
        throw new Error("invalid GitHub Check request");
      }
      const check = parseCheckRun(
        await checkRequest(`https://api.github.com/repos/${path}/check-runs`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name,
            head_sha: headSha,
            external_id: runId,
            status: "queued",
          }),
        }),
      );
      if (
        check.name !== name ||
        check.headSha !== headSha ||
        check.externalId !== runId ||
        check.status !== "queued" ||
        check.conclusion !== null
      ) {
        throw new Error("invalid GitHub Check response");
      }
      return check;
    },

    async reconcileCheck({ token, repository, name, headSha, runId }) {
      const { path, headers } = checkArguments(token, repository);
      if (name.length === 0 || runId.length === 0 || !SHA.test(headSha)) {
        throw new Error("invalid GitHub Check request");
      }
      let page = 1;
      let examined = 0;
      let expectedTotal: number | undefined;
      const seenCheckIds = new Set<number>();
      while (true) {
        const query = new URLSearchParams({
          check_name: name,
          filter: "all",
          per_page: "100",
          page: String(page),
        });
        const value = await checkRequest(
          `https://api.github.com/repos/${path}/commits/${headSha}/check-runs?${query.toString()}`,
          { method: "GET", headers },
        );
        if (!isRecord(value)) throw new Error("invalid GitHub Check response");
        const totalCount = value.total_count;
        if (typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < 0) {
          throw new Error("invalid GitHub Check response");
        }
        if (expectedTotal === undefined) expectedTotal = totalCount;
        if (totalCount !== expectedTotal || !Array.isArray(value.check_runs)) {
          throw new Error("invalid GitHub Check response");
        }
        const checks = value.check_runs.map(parseCheckRun);
        const pageCheckIds = new Set<number>();
        const duplicatePageId = checks.some((check) => {
          if (pageCheckIds.has(check.id)) return true;
          pageCheckIds.add(check.id);
          return false;
        });
        if (
          examined + checks.length > expectedTotal ||
          (checks.length === 0 && examined < expectedTotal) ||
          duplicatePageId ||
          checks.some(
            (check) =>
              check.name !== name || check.headSha !== headSha || seenCheckIds.has(check.id),
          )
        ) {
          throw new Error("invalid GitHub Check response");
        }
        for (const check of checks) seenCheckIds.add(check.id);
        const match = checks.find((check) => check.externalId === runId);
        if (match) return match;
        examined += checks.length;
        if (examined === expectedTotal) return undefined;
        page += 1;
        if (!Number.isSafeInteger(page)) throw new Error("invalid GitHub Check response");
      }
    },

    async markCheckInProgress({ token, repository, checkRunId }) {
      const { path, headers } = checkArguments(token, repository);
      if (!positiveInteger(checkRunId)) throw new Error("invalid GitHub Check request");
      const check = parseCheckRun(
        await checkRequest(`https://api.github.com/repos/${path}/check-runs/${checkRunId}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ status: "in_progress" }),
        }),
      );
      if (check.id !== checkRunId || check.status !== "in_progress" || check.conclusion !== null) {
        throw new Error("invalid GitHub Check response");
      }
      return check;
    },

    async completeCheck({ token, repository, checkRunId, conclusion, output }) {
      const { path, headers } = checkArguments(token, repository);
      if (!positiveInteger(checkRunId)) throw new Error("invalid GitHub Check request");
      if (
        (output !== undefined &&
          (!isRecord(output) ||
            conclusion !== "failure" ||
            Object.keys(output).sort().join(",") !== "summary,title" ||
            typeof output.title !== "string" ||
            new TextEncoder().encode(output.title).byteLength < 1 ||
            new TextEncoder().encode(output.title).byteLength > 255 ||
            typeof output.summary !== "string" ||
            new TextEncoder().encode(output.summary).byteLength < 1 ||
            new TextEncoder().encode(output.summary).byteLength > 65_535)) ||
        (conclusion !== "failure" && output !== undefined)
      ) {
        throw new Error("invalid GitHub Check request");
      }
      const response = await checkRequest(
        `https://api.github.com/repos/${path}/check-runs/${checkRunId}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ status: "completed", conclusion, ...(output ? { output } : {}) }),
        },
      );
      const check = parseCheckRun(response);
      const responseOutput = isRecord(response) ? response.output : undefined;
      if (
        check.id !== checkRunId ||
        check.status !== "completed" ||
        check.conclusion !== conclusion ||
        (output !== undefined &&
          (!isRecord(responseOutput) ||
            responseOutput.title !== output.title ||
            responseOutput.summary !== output.summary))
      ) {
        throw new Error("invalid GitHub Check response");
      }
      return check;
    },
  };
};
