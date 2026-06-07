import type { Env } from "../env.ts";
import type { SandboxArgs, SandboxHandle } from "./types.ts";
import { assertSafeRef, redact, sandboxFor } from "./util.ts";

const DIR = "/work/repo";

// Create (or wake) the sandbox for this run and clone the working repo into it. Returns a
// serializable handle; later steps re-acquire the sandbox by `id`.
export const runSandbox = async (env: Env, args: SandboxArgs): Promise<SandboxHandle> => {
  const base = args.base ?? "main";
  assertSafeRef(args.branch, base);

  const id = `runway-${args.branch.replace(/[^A-Za-z0-9-]/g, "-").toLowerCase()}`;
  const sandbox = sandboxFor(env, id);

  const remote = remoteFor(env, args.from);
  await sandbox.setEnvVars({ GIT_TERMINAL_PROMPT: "0" });

  const clone = await sandbox.exec(
    `rm -rf ${DIR} && git clone ${remote} ${DIR} && cd ${DIR} && ` +
      `git config user.email runway@local && git config user.name Runway && ` +
      `git checkout -B ${args.branch}`,
  );
  if (clone.exitCode !== 0) throw new Error(`clone failed: ${redact(clone.stderr)}`);

  return { id, dir: DIR, branch: args.branch, base };
};

// Build an authenticated clone URL for either an artifact fork or a GitHub "owner/repo".
const remoteFor = (env: Env, from: SandboxArgs["from"]): string => {
  if (typeof from === "string") {
    return `https://x-access-token:${env.GITHUB_TOKEN}@github.com/${from}.git`;
  }
  // Artifact handle: inject the scoped write token into its remote.
  const host = from.remote.replace(/^https:\/\//, "");
  return `https://x:${from.token}@${host}`;
};
