import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { collectResultItems, defaultClient } from "./cloudflare-api.ts";
import type { CloudflareApi } from "./cloudflare-api.ts";

interface DeployAuthContext {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly client?: (opts: { apiToken: string }) => CloudflareApi;
  readonly wranglerAuth?: boolean;
}

const execFileAsync = promisify(execFile);

const wranglerTokenOf = async (
  opts: DeployAuthContext,
  env: Record<string, string | undefined>,
): Promise<string | undefined> => {
  if (opts.wranglerAuth === false || env.RUNWAY_DISABLE_WRANGLER_AUTH) return undefined;
  try {
    const { stdout } = await execFileAsync("wrangler", ["auth", "token", "--json"], {
      cwd: opts.cwd,
      env: { ...process.env, ...env },
      timeout: 10_000,
    });
    const auth = JSON.parse(stdout) as { type?: unknown; token?: unknown };
    return (auth.type === "oauth" || auth.type === "api_token") && typeof auth.token === "string"
      ? auth.token
      : undefined;
  } catch {
    return undefined;
  }
};

const accountIdsOf = async (response: unknown): Promise<ReadonlyArray<string>> =>
  collectResultItems(response, (item) =>
    item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
      ? (item as { id: string }).id
      : undefined,
  );

export const resolveAuth = async (
  opts: DeployAuthContext,
  env: Record<string, string | undefined>,
): Promise<{ accountId: string; cf: CloudflareApi }> => {
  const apiToken = env.CLOUDFLARE_API_TOKEN ?? (await wranglerTokenOf(opts, env));
  if (!apiToken) {
    throw new Error(
      `missing required env var(s): ${["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].join(", ")}; or run wrangler login`,
    );
  }
  const cf: CloudflareApi = opts.client?.({ apiToken }) ?? defaultClient(apiToken);
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (accountId) return { accountId, cf };

  const accountIds = await accountIdsOf(await cf.accounts.list());
  if (accountIds.length === 1) return { accountId: accountIds[0]!, cf };
  if (accountIds.length > 1) {
    throw new Error("multiple Cloudflare accounts found; set CLOUDFLARE_ACCOUNT_ID");
  }
  throw new Error("missing required env var(s): CLOUDFLARE_ACCOUNT_ID");
};
