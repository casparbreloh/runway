import { NonRetryableError } from "cloudflare:workflows";

import type { Env } from "../env.ts";
import type { ArtifactForkArgs, ArtifactHandle } from "./types.ts";

// Fork the working repo for this run. We keep one read-only baseline Artifacts repo per
// GitHub source (imported once), then fork it per session so each run diverges in
// isolation — Cloudflare's documented pattern. The fork is "where the code lives".
export const runArtifactFork = async (
  env: Env,
  args: ArtifactForkArgs,
): Promise<ArtifactHandle> => {
  const slug = args.from.replace("/", "-");
  const baselineName = `${slug}-baseline`;

  const baseline = await ensureBaseline(env, baselineName, args.from);
  const sessionName = `${slug}-${args.as}`;
  const fork = await baseline.fork(sessionName, { description: `runway session ${args.as}` });

  return { name: sessionName, remote: fork.remote, token: fork.token };
};

const ensureBaseline = async (env: Env, name: string, from: string) => {
  try {
    return await env.ARTIFACTS.get(name);
  } catch {
    // Not imported yet — bootstrap the baseline from GitHub, read-only.
    await env.ARTIFACTS.import({
      source: { url: `https://github.com/${from}.git` },
      target: { name },
    });
    try {
      return await env.ARTIFACTS.get(name);
    } catch (e) {
      throw new NonRetryableError(`failed to import artifact baseline for ${from}: ${String(e)}`);
    }
  }
};
