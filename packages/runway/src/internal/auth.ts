import { spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { collectResultItems, defaultClient } from "./cloudflare.ts";
import type { CloudflareApi } from "./cloudflare.ts";

export interface WranglerCommandOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly stdio: "capture" | "inherit";
  readonly timeoutMs?: number;
}

export type WranglerCommand = (
  args: ReadonlyArray<string>,
  options: WranglerCommandOptions,
) => Promise<{
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}>;

export interface CloudflareAccount {
  readonly id: string;
  readonly name?: string;
}

export type AccountSelector = (accounts: ReadonlyArray<CloudflareAccount>) => Promise<string>;

interface CloudflareAuthContext {
  readonly cwd: string;
  readonly client?: (opts: { apiToken: string }) => CloudflareApi;
  readonly wranglerAuth?: boolean;
  readonly interactive?: boolean;
  readonly wranglerCommand?: WranglerCommand;
  readonly accountSelector?: AccountSelector;
}

class WranglerUnavailableError extends Error {}

const wranglerEnvironment = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const source = { ...process.env, ...overrides };
  const names = new Set([
    "ALL_PROXY",
    "APPDATA",
    "CI",
    "CLOUDFLARE_AUTH_USE_KEYRING",
    "ComSpec",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LOCALAPPDATA",
    "NODE_EXTRA_CA_CERTS",
    "NO_PROXY",
    "PATH",
    "PATHEXT",
    "SHELL",
    "SSL_CERT_FILE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WRANGLER_HOME",
    "WRANGLER_LOG",
    "WRANGLER_LOG_PATH",
    "WRANGLER_SEND_METRICS",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(([name, value]) => value !== undefined && names.has(name)),
  );
};

const defaultWranglerCommand: WranglerCommand = async (args, options) =>
  await new Promise((resolve, reject) => {
    const child = spawn("wrangler", args, {
      cwd: options.cwd,
      env: wranglerEnvironment(options.env),
      stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (options.stdio === "capture") {
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new WranglerUnavailableError() : error);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`wrangler ${args.join(" ")} terminated by ${signal}`));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });

const wranglerEnabled = (opts: CloudflareAuthContext): boolean => opts.wranglerAuth !== false;

const wranglerTokenOf = async (
  opts: CloudflareAuthContext,
  env: Record<string, string | undefined>,
): Promise<
  | { readonly state: "authenticated"; readonly token: string }
  | { readonly state: "unauthenticated" | "unavailable" }
> => {
  if (!wranglerEnabled(opts)) return { state: "unavailable" };
  try {
    const result = await (opts.wranglerCommand ?? defaultWranglerCommand)(
      ["auth", "token", "--json"],
      { cwd: opts.cwd, env, stdio: "capture", timeoutMs: 10_000 },
    );
    if ((result.exitCode ?? 0) !== 0) {
      if (/not (?:authenticated|logged in)|wrangler login/i.test(result.stderr ?? "")) {
        return { state: "unauthenticated" };
      }
      throw new Error(`Wrangler authentication check failed: ${(result.stderr ?? "").trim()}`);
    }
    let auth: { type?: unknown; token?: unknown };
    try {
      auth = JSON.parse(result.stdout) as { type?: unknown; token?: unknown };
    } catch {
      throw new Error("Wrangler returned invalid authentication output");
    }
    if (
      (auth.type !== "oauth" && auth.type !== "api_token") ||
      typeof auth.token !== "string" ||
      auth.token.length === 0
    ) {
      throw new Error("Wrangler returned invalid authentication output");
    }
    return { state: "authenticated", token: auth.token };
  } catch (error) {
    if (error instanceof WranglerUnavailableError) return { state: "unavailable" };
    throw error;
  }
};

const runWranglerLogin = async (
  opts: CloudflareAuthContext,
  env: Record<string, string | undefined>,
): Promise<void> => {
  console.error("Runway uses Wrangler, Cloudflare's official CLI, to sign in to Cloudflare.");
  try {
    const result = await (opts.wranglerCommand ?? defaultWranglerCommand)(["login"], {
      cwd: opts.cwd,
      env,
      stdio: "inherit",
    });
    if ((result.exitCode ?? 0) !== 0) throw new Error("Wrangler login failed");
  } catch (error) {
    if (error instanceof WranglerUnavailableError) {
      throw new Error("Wrangler is not installed");
    }
    throw error;
  }
};

const accountsOf = async (response: unknown): Promise<ReadonlyArray<CloudflareAccount>> =>
  collectResultItems(response, (item) => {
    if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") {
      return undefined;
    }
    const { id, name } = item as { id: string; name?: unknown };
    return { id, ...(typeof name === "string" && name.length > 0 ? { name } : {}) };
  });

const selectAccount: AccountSelector = async (accounts) => {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write("Multiple Cloudflare accounts are accessible:\n");
    accounts.forEach(({ id, name }, index) =>
      process.stderr.write(`  ${index + 1}. ${name ? `${name} (${id})` : id}\n`),
    );
    const answer = await readline.question(`Select an account [1-${accounts.length}]: `);
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= accounts.length) {
      throw new Error(`invalid Cloudflare account selection: ${JSON.stringify(answer)}`);
    }
    return accounts[index]!.id;
  } finally {
    readline.close();
  }
};

const missingAuthentication = (): Error =>
  new Error(
    "Cloudflare authentication required; install Wrangler and run `wrangler login`, or set CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID when needed)",
  );

export const resolveAuth = async (
  opts: CloudflareAuthContext,
  env: Record<string, string | undefined>,
): Promise<{ accountId: string; cf: CloudflareApi }> => {
  let apiToken = env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    let wrangler = await wranglerTokenOf(opts, env);
    if (
      wrangler.state === "unauthenticated" &&
      opts.interactive === true &&
      !env.CI &&
      wranglerEnabled(opts)
    ) {
      await runWranglerLogin(opts, env);
      wrangler = await wranglerTokenOf(opts, env);
    }
    if (wrangler.state === "authenticated") apiToken = wrangler.token;
  }
  if (!apiToken) throw missingAuthentication();

  const cf: CloudflareApi = opts.client?.({ apiToken }) ?? defaultClient(apiToken);
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (accountId) return { accountId, cf };

  const accounts = await accountsOf(await cf.accounts.list());
  if (accounts.length === 1) return { accountId: accounts[0]!.id, cf };
  if (accounts.length > 1) {
    if (opts.interactive !== true) {
      throw new Error("multiple Cloudflare accounts found; set CLOUDFLARE_ACCOUNT_ID");
    }
    const selected = await (opts.accountSelector ?? selectAccount)(accounts);
    if (!accounts.some(({ id }) => id === selected)) {
      throw new Error(`selected Cloudflare account is not accessible: ${JSON.stringify(selected)}`);
    }
    return { accountId: selected, cf };
  }
  throw new Error("no accessible Cloudflare accounts found");
};
