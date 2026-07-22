import type { GitHubRepository } from "../../trigger.ts";
import { concatBytes } from "./byte.ts";
import { githubRepositoryName, validGitHubRepository } from "./repository.ts";

const SHA = /^[0-9a-f]{40}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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
  if (!validGitHubRepository(repository)) throw new Error("invalid GitHub Check request");
  const parsed = githubRepositoryName(repository.fullName)!;
  return `${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`;
};

const repositoryNamePath = (fullName: string): { readonly path: string; readonly name: string } => {
  const parsed = githubRepositoryName(fullName);
  if (!parsed) throw new Error("invalid GitHub repository name");
  return {
    path: `${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`,
    name: parsed.name,
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

const checkIdentityArguments = (
  token: string,
  repository: GitHubRepository,
  name: string,
  headSha: string,
  runId: string,
): { readonly path: string; readonly headers: Headers } => {
  const result = checkArguments(token, repository);
  if (name.length === 0 || runId.length === 0 || !SHA.test(headSha)) {
    throw new Error("invalid GitHub Check request");
  }
  return result;
};

const parseInstallationToken = async (
  response: Response,
  now: () => number,
): Promise<{
  readonly token: string;
  readonly expiresAt: string;
  readonly repositories: unknown;
}> => {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("invalid GitHub installation token response");
  }
  if (!isRecord(value)) throw new Error("invalid GitHub installation token response");
  const { token, expires_at: expiresAt, repositories } = value;
  const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  const currentTime = now();
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= currentTime ||
    expiresAtMs > currentTime + 60 * 60 * 1000
  ) {
    throw new Error("invalid GitHub installation token response");
  }
  return { token, expiresAt, repositories };
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

  const lookupInstallation = async (
    path: string,
    jwt: string,
    expected?: { readonly installationId: number; readonly repositoryId: number },
  ): Promise<number> => {
    const requestFailure = expected
      ? "GitHub installation token request failed"
      : "GitHub repository resolution failed";
    let response: Response;
    try {
      response = await fetchImpl(`https://api.github.com/repos/${path}/installation`, {
        method: "GET",
        headers: githubHeaders(`Bearer ${jwt}`),
      });
    } catch {
      throw new Error(requestFailure);
    }
    if (expected && response.status === 404) {
      throw new GitHubRepositoryUnavailableError(expected.installationId, expected.repositoryId);
    }
    if (!response.ok) throw new Error(`${requestFailure} (${response.status})`);
    let installation: unknown;
    try {
      installation = await response.json();
    } catch {
      throw new Error("invalid GitHub repository installation response");
    }
    if (
      !isRecord(installation) ||
      !positiveInteger(installation.id) ||
      (expected && installation.id !== expected.installationId)
    ) {
      throw new Error("invalid GitHub repository installation response");
    }
    return installation.id;
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
      const installationId = await lookupInstallation(path, jwt);
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
      const { repositories } = await parseInstallationToken(tokenResponse, now);
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
      if (!canonical || !candidateRepository) {
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
      await lookupInstallation(scopedRepositoryPath, jwt, {
        installationId,
        repositoryId: repository.id,
      });
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
      const { token, expiresAt, repositories } = await parseInstallationToken(response, now);
      const requestedRepositoryGranted =
        Array.isArray(repositories) &&
        repositories.length === 1 &&
        isRecord(repositories[0]) &&
        repositories[0].id === repository.id;
      if (!requestedRepositoryGranted) {
        throw new Error("invalid GitHub installation token response");
      }
      return { token, expiresAt };
    },

    async createQueuedCheck({ token, repository, name, headSha, runId }) {
      const { path, headers } = checkIdentityArguments(token, repository, name, headSha, runId);
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
      const { path, headers } = checkIdentityArguments(token, repository, name, headSha, runId);
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
