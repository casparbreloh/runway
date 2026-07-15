import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export interface RepositorySource {
  readonly remote: string;
  readonly commit: string;
  readonly authentication: { readonly type: "public" };
}

const execFileAsync = promisify(execFile);
const REPOSITORY_REACHABILITY_TIMEOUT_MS = 60_000;

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
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`invalid repository commit: ${commit}`);
  return {
    remote: publicRemote(remote),
    commit,
    authentication: { type: "public" },
  };
};

export const assertRepositorySourceReachable = async (
  repository: RepositorySource,
): Promise<void> => {
  const cwd = await mkdtemp(path.join(tmpdir(), "runway-repository-"));
  try {
    await execFileAsync("git", ["-C", cwd, "init", "--quiet"], { encoding: "utf8" });
    await execFileAsync(
      "git",
      [
        "-C",
        cwd,
        "fetch",
        "--quiet",
        "--depth=1",
        "--filter=blob:none",
        repository.remote,
        repository.commit,
      ],
      { encoding: "utf8", timeout: REPOSITORY_REACHABILITY_TIMEOUT_MS },
    );
  } catch {
    throw new Error(`repository remote does not contain commit ${repository.commit}`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};
