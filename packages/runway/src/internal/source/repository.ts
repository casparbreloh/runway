import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { GitHubRepository } from "../../github.ts";
import type { SourceIdentity } from "./source.ts";

interface PublicRepositoryAuthentication {
  readonly type: "public";
}

export interface GitHubRepositoryAuthentication {
  readonly type: "github";
  readonly installationId: number;
  readonly repository: GitHubRepository;
}

export interface RepositorySource {
  readonly remote: string;
  readonly commit: string;
  readonly authentication: PublicRepositoryAuthentication | GitHubRepositoryAuthentication;
}

export interface GitHubRunSource {
  readonly type: "github";
  readonly installationId: number;
  readonly repository: GitHubRepository;
  readonly commit: string;
  readonly deliveryId: string;
  readonly runId: string;
  readonly generation: number;
  readonly admission:
    | { readonly type: "push"; readonly ref: string; readonly defaultRef: string }
    | { readonly type: "pull_request"; readonly number: number; readonly defaultRef: string };
  readonly check: {
    readonly id: number;
    readonly name: string;
    readonly repository: GitHubRepository;
  };
}

interface ReachabilityExecOptions {
  readonly cwd?: string;
  readonly encoding: "utf8";
  readonly timeout?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RepositoryReachabilityOptions {
  readonly installationToken?: (request: {
    readonly purpose: "checkout";
    readonly authentication: GitHubRepositoryAuthentication;
  }) => Promise<string>;
  readonly exec?: (
    file: string,
    args: ReadonlyArray<string>,
    options: ReachabilityExecOptions,
  ) => Promise<{ readonly stdout: string }>;
}

const execFileAsync = promisify(execFile);
const REPOSITORY_REACHABILITY_TIMEOUT_MS = 60_000;
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const exactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

const invalidRefCharacter = (character: string): boolean => {
  const code = character.charCodeAt(0);
  return code <= 0x20 || code === 0x7f || "\\~^:?*[".includes(character);
};

const branchRef = (value: unknown): value is string => {
  if (typeof value !== "string" || !value.startsWith("refs/heads/")) return false;
  const name = value.slice("refs/heads/".length);
  return (
    name.length > 0 &&
    !name.startsWith(".") &&
    !name.endsWith(".") &&
    !name.endsWith("/") &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.includes("@{") &&
    !Array.from(name).some(invalidRefCharacter) &&
    name.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
  );
};

export const githubRepositoryRemote = (repository: GitHubRepository): string => {
  const parts = repository.fullName.split("/");
  if (
    !positiveInteger(repository.id) ||
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !REPOSITORY_PART.test(parts[0]) ||
    !REPOSITORY_PART.test(parts[1]) ||
    repository.name !== parts[1]
  ) {
    throw new Error("invalid GitHub repository identity");
  }
  return `https://github.com/${repository.fullName}`;
};

const parseGitHubRepository = (value: unknown): GitHubRepository => {
  if (!isRecord(value) || !exactKeys(value, ["id", "name", "fullName"])) {
    throw new Error("invalid GitHub repository identity");
  }
  const repository = value as unknown as GitHubRepository;
  githubRepositoryRemote(repository);
  return {
    id: repository.id,
    name: repository.name,
    fullName: repository.fullName,
  };
};

const publicRemote = (remote: string): string => {
  const scp = /^git@github\.com:([^/]+\/.+)$/.exec(remote);
  if (scp) return `https://github.com/${scp[1]}`;
  const ssh = /^ssh:\/\/git@github\.com\/([^/]+\/.+)$/.exec(remote);
  if (ssh) return `https://github.com/${ssh[1]}`;
  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    throw new Error(`unsupported public repository remote: ${remote}`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`public repository remote must be credential-free HTTPS: ${remote}`);
  }
  return parsed.toString();
};

export const parseRepositorySource = (value: unknown): RepositorySource => {
  if (!isRecord(value) || !exactKeys(value, ["remote", "commit", "authentication"])) {
    throw new Error("invalid repository source");
  }
  const { remote, commit, authentication } = value;
  if (
    typeof remote !== "string" ||
    typeof commit !== "string" ||
    !SHA.test(commit) ||
    !isRecord(authentication)
  ) {
    throw new Error("invalid repository source");
  }
  if (exactKeys(authentication, ["type"]) && authentication.type === "public") {
    const normalizedRemote = publicRemote(remote);
    if (normalizedRemote !== remote) throw new Error("invalid repository source");
    return { remote, commit, authentication: { type: "public" } };
  }
  if (
    exactKeys(authentication, ["type", "installationId", "repository"]) &&
    authentication.type === "github" &&
    positiveInteger(authentication.installationId)
  ) {
    const repository = parseGitHubRepository(authentication.repository);
    if (remote !== githubRepositoryRemote(repository)) throw new Error("invalid repository source");
    return {
      remote,
      commit,
      authentication: {
        type: "github",
        installationId: authentication.installationId,
        repository,
      },
    };
  }
  throw new Error("invalid repository source");
};

export const sourceIdentity = (repository: RepositorySource): SourceIdentity => {
  const parsed = parseRepositorySource(repository);
  return {
    repositoryId:
      parsed.authentication.type === "github"
        ? `github:${parsed.authentication.repository.id}`
        : `remote:${parsed.remote}`,
    remote: parsed.remote,
    revision: parsed.commit,
  };
};

export const parseGitHubRunSource = (value: unknown): GitHubRunSource => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "type",
      "installationId",
      "repository",
      "commit",
      "deliveryId",
      "runId",
      "generation",
      "admission",
      "check",
    ]) ||
    value.type !== "github" ||
    !positiveInteger(value.installationId) ||
    typeof value.commit !== "string" ||
    !SHA.test(value.commit) ||
    typeof value.deliveryId !== "string" ||
    !UUID.test(value.deliveryId) ||
    typeof value.runId !== "string" ||
    value.runId.length === 0 ||
    !positiveInteger(value.generation) ||
    !isRecord(value.admission) ||
    !isRecord(value.check) ||
    !exactKeys(value.check, ["id", "name", "repository"]) ||
    !positiveInteger(value.check.id) ||
    typeof value.check.name !== "string" ||
    value.check.name.length === 0
  ) {
    throw new Error("invalid GitHub run source");
  }
  const admission = value.admission;
  const parsedAdmission =
    exactKeys(admission, ["type", "ref", "defaultRef"]) &&
    admission.type === "push" &&
    branchRef(admission.ref) &&
    branchRef(admission.defaultRef)
      ? ({ type: "push", ref: admission.ref, defaultRef: admission.defaultRef } as const)
      : exactKeys(admission, ["type", "number", "defaultRef"]) &&
          admission.type === "pull_request" &&
          positiveInteger(admission.number) &&
          branchRef(admission.defaultRef)
        ? ({
            type: "pull_request",
            number: admission.number,
            defaultRef: admission.defaultRef,
          } as const)
        : undefined;
  if (!parsedAdmission) throw new Error("invalid GitHub run source");
  return {
    type: "github",
    installationId: value.installationId,
    repository: parseGitHubRepository(value.repository),
    commit: value.commit,
    deliveryId: value.deliveryId,
    runId: value.runId,
    generation: value.generation,
    admission: parsedAdmission,
    check: {
      id: value.check.id,
      name: value.check.name,
      repository: parseGitHubRepository(value.check.repository),
    },
  };
};

export const repositorySourceForRun = (source: GitHubRunSource): RepositorySource => ({
  remote: githubRepositoryRemote(source.repository),
  commit: source.commit,
  authentication: {
    type: "github",
    installationId: source.installationId,
    repository: source.repository,
  },
});

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    return stdout.trim();
  } catch {
    throw new Error(`could not resolve repository source from ${cwd}`);
  }
};

export const resolveRepositorySource = async (cwd: string): Promise<RepositorySource> => {
  const [remote, commit] = await Promise.all([
    git(cwd, ["remote", "get-url", "origin"]),
    git(cwd, ["rev-parse", "HEAD"]),
  ]);
  if (!SHA.test(commit)) throw new Error(`invalid repository commit: ${commit}`);
  return parseRepositorySource({
    remote: publicRemote(remote),
    commit,
    authentication: { type: "public" },
  });
};

const askpassSource = `#!/bin/sh
case "$1" in
  "Username for 'https://github.com': ") printf '%s\\n' 'x-access-token' ;;
  "Password for 'https://x-access-token@github.com': ") printf '%s\\n' "$RUNWAY_GITHUB_TOKEN" ;;
  *) exit 1 ;;
esac
`;

export const assertRepositorySourceReachable = async (
  repository: RepositorySource,
  options: RepositoryReachabilityOptions = {},
): Promise<void> => {
  const source = parseRepositorySource(repository);
  const cwd = await mkdtemp(path.join(tmpdir(), "runway-repository-"));
  const askpass = path.join(cwd, "git-askpass");
  let token: string | undefined;
  const execute = options.exec ?? (execFileAsync as unknown as NonNullable<typeof options.exec>);
  try {
    await execute("git", ["-C", cwd, "init", "--quiet"], { encoding: "utf8" });
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (source.authentication.type === "github") {
      if (!options.installationToken) throw new Error("missing GitHub repository authentication");
      token = await options.installationToken({
        purpose: "checkout",
        authentication: source.authentication,
      });
      if (!token) throw new Error("missing GitHub repository authentication");
      await writeFile(askpass, askpassSource, { mode: 0o700 });
      env.GIT_ASKPASS = askpass;
      env.RUNWAY_GITHUB_TOKEN = token;
    }
    await execute(
      "git",
      [
        "-c",
        "http.followRedirects=false",
        "-C",
        cwd,
        "fetch",
        "--quiet",
        "--depth=1",
        "--filter=blob:none",
        source.remote,
        source.commit,
      ],
      { encoding: "utf8", timeout: REPOSITORY_REACHABILITY_TIMEOUT_MS, env },
    );
  } catch {
    throw new Error(`repository remote does not contain commit ${source.commit}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};
