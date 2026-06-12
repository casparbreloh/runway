import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import Cloudflare, { toFile } from "cloudflare";
import { build as esbuild } from "esbuild";
import type { Plugin } from "esbuild";

import {
  COMPATIBILITY_DATE,
  DYNAMIC_WORKFLOW_CLASS,
  LOADER_BINDING,
  WORKFLOW_BINDING,
  WORKFLOW_NAME,
  cronsOf,
  generateDynamicWorker,
  generateWorker,
} from "./codegen.ts";
import { secretNamesOf } from "./registry.ts";
import type { ProgressEvent, RegisteredWorkflow, Registry } from "./types.ts";

type AsyncMethod<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<unknown>;

export type CloudflareApi = {
  accounts: {
    list(): Promise<unknown>;
  };
  workers: {
    scripts: {
      update: AsyncMethod<Cloudflare["workers"]["scripts"]["update"]>;
      schedules: {
        update: AsyncMethod<Cloudflare["workers"]["scripts"]["schedules"]["update"]>;
      };
      subdomain: {
        create: AsyncMethod<Cloudflare["workers"]["scripts"]["subdomain"]["create"]>;
      };
    };
    subdomains: {
      get(params: { account_id: string }): Promise<unknown>;
    };
  };
  workflows: {
    update: AsyncMethod<Cloudflare["workflows"]["update"]>;
    list(params: { account_id: string }): Promise<unknown>;
    delete: AsyncMethod<Cloudflare["workflows"]["delete"]>;
  };
};

interface DeployContext {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly client?: (opts: { apiToken: string }) => CloudflareApi;
  readonly wranglerAuth?: boolean;
}

interface DeployOutput {
  readonly script: string;
  readonly urls: ReadonlyArray<{ readonly id: string; readonly url: string }>;
}

const defaultClient = (apiToken: string): CloudflareApi => {
  const cf = new Cloudflare({ apiToken });
  return {
    accounts: cf.accounts,
    workers: cf.workers,
    workflows: cf.workflows,
  };
};

const resultOf = (response: unknown): unknown =>
  response && typeof response === "object" && "result" in response
    ? (response as { result: unknown }).result
    : response;

const SCRIPT_NAME = "runway";
const execFileAsync = promisify(execFile);

const validateBindings = (secrets: ReadonlyArray<string>): void => {
  const names = new Map<string, string>();
  names.set(WORKFLOW_BINDING, "Runway workflow binding");
  names.set(LOADER_BINDING, "Runway worker loader binding");
  for (const secret of secrets) {
    const owner = names.get(secret);
    if (owner) {
      throw new Error(`binding ${JSON.stringify(secret)} is used by ${owner} and a secret`);
    }
  }
};

const parseTomlString = (contents: string, key: string): string | undefined => {
  const match = contents.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match?.[1];
};

const parseTomlNumber = (contents: string, key: string): number | undefined => {
  const match = contents.match(new RegExp(`^${key}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)`, "m"));
  return match ? Number(match[1]) : undefined;
};

const validExpiry = (expires: number | undefined): boolean => {
  if (expires === undefined) return false;
  const ms = expires < 10_000_000_000 ? expires * 1000 : expires;
  return ms > Date.now() + 30_000;
};

const wranglerConfigPaths = (env: Record<string, string | undefined>): ReadonlyArray<string> => {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  if (!home) return [];
  const xdg = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return [
    path.join(xdg, ".wrangler", "config", "default.toml"),
    path.join(home, ".wrangler", "config", "default.toml"),
  ];
};

const runWranglerWhoami = async (
  opts: DeployContext,
  env: Record<string, string | undefined>,
): Promise<boolean> => {
  try {
    await execFileAsync("wrangler", ["whoami", "--json"], {
      cwd: opts.cwd,
      env: { ...process.env, ...env },
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
};

const wranglerTokenOf = async (
  opts: DeployContext,
  env: Record<string, string | undefined>,
): Promise<string | undefined> => {
  if (opts.wranglerAuth === false || env.RUNWAY_DISABLE_WRANGLER_AUTH) return undefined;
  if (!(await runWranglerWhoami(opts, env))) return undefined;
  for (const configPath of wranglerConfigPaths(env)) {
    try {
      const contents = await readFile(configPath, "utf8");
      const apiToken = parseTomlString(contents, "api_token");
      if (apiToken) return apiToken;
      const oauthToken = parseTomlString(contents, "oauth_token");
      if (oauthToken && validExpiry(parseTomlNumber(contents, "expiration_time"))) {
        return oauthToken;
      }
    } catch {}
  }
  return undefined;
};

const accountIdsOf = async (response: unknown): Promise<ReadonlyArray<string>> => {
  const ids: string[] = [];
  const collect = (item: unknown): void => {
    if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      ids.push((item as { id: string }).id);
    }
  };
  const result = resultOf(response);
  if (Array.isArray(result)) {
    result.forEach(collect);
    return ids;
  }
  if (response && typeof response === "object" && Symbol.asyncIterator in response) {
    for await (const item of response as AsyncIterable<unknown>) collect(item);
  }
  return ids;
};

const resolveAuth = async (
  opts: DeployContext,
  env: Record<string, string | undefined>,
  missingSecrets: ReadonlyArray<string>,
): Promise<{ accountId: string; cf: CloudflareApi }> => {
  const apiToken = env.CLOUDFLARE_API_TOKEN ?? (await wranglerTokenOf(opts, env));
  if (!apiToken) {
    throw new Error(
      `missing required env var(s): ${[
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_ACCOUNT_ID",
        ...missingSecrets,
      ].join(", ")}; or run wrangler login`,
    );
  }
  if (missingSecrets.length > 0) {
    throw new Error(`missing required env var(s): ${missingSecrets.join(", ")}`);
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

const esbuildBase = {
  bundle: true,
  format: "esm" as const,
  platform: "browser" as const,
  external: ["cloudflare:*", "node:*", ...builtinModules],
  write: false,
};

const runtimeDependencyResolver: Plugin = {
  name: "runway-runtime-dependencies",
  setup(build) {
    build.onResolve({ filter: /^@cloudflare\/dynamic-workflows$/ }, () => ({
      path: path.resolve(
        import.meta.dirname,
        "../node_modules/@cloudflare/dynamic-workflows/dist/index.js",
      ),
    }));
  },
};

const outputOf = (
  outputFiles: ReadonlyArray<{ contents: Uint8Array; text: string }> | undefined,
) => {
  const output = outputFiles?.[0];
  if (!output) throw new Error("esbuild returned no output");
  return output;
};

const hashOf = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const buildDynamicWorker = async (
  workflow: RegisteredWorkflow,
  opts: DeployContext,
): Promise<string> => {
  const entry = path.join(opts.cwd, `workflow-${workflow.def.id}.gen.ts`);
  const source = generateDynamicWorker(workflow, { cwd: opts.cwd });
  const result = await esbuild({
    ...esbuildBase,
    entryPoints: [`runway:workflow:${workflow.def.id}`],
    plugins: [
      runtimeDependencyResolver,
      {
        name: "runway-dynamic-workflow",
        setup(build) {
          build.onResolve({ filter: /^runway:workflow:/ }, () => ({
            path: entry,
          }));
          build.onLoad({ filter: /^.*\/workflow-.*\.gen\.ts$/ }, () => ({
            contents: source,
            loader: "ts",
            resolveDir: opts.cwd,
          }));
        },
      },
    ],
  });
  return outputOf(result.outputFiles).text;
};

const build = async (
  registry: Registry,
  opts: DeployContext,
  secrets: ReadonlyArray<string>,
): Promise<Uint8Array> => {
  validateBindings(secrets);
  opts.onProgress?.({ step: "build", status: "start" });
  const deployId = randomUUID();
  const dynamicWorkers = await Promise.all(
    registry.map(async (w) => {
      const code = await buildDynamicWorker(w, opts);
      const loaderId = `${w.def.id}-${hashOf(code)}-${deployId}`;
      return { workflowId: w.def.id, loaderId, code };
    }),
  );
  const modules = Object.fromEntries(dynamicWorkers.map((w) => [w.loaderId, w.code]));
  const workflowLoaders = Object.fromEntries(dynamicWorkers.map((w) => [w.workflowId, w.loaderId]));
  const entry = path.join(opts.cwd, "worker.gen.ts");
  const worker = generateWorker(registry, { cwd: opts.cwd, modules, workflowLoaders });
  const result = await esbuild({
    ...esbuildBase,
    entryPoints: ["runway:worker"],
    plugins: [
      runtimeDependencyResolver,
      {
        name: "runway-worker",
        setup(build) {
          build.onResolve({ filter: /^runway:worker$/ }, () => ({
            path: entry,
          }));
          build.onLoad({ filter: /^.*\/worker\.gen\.ts$/ }, () => ({
            contents: worker,
            loader: "ts",
            resolveDir: opts.cwd,
          }));
        },
      },
    ],
  });
  const contents = outputOf(result.outputFiles).contents;
  opts.onProgress?.({ step: "build", status: "done" });
  return contents;
};

export const deploy = async (registry: Registry, opts: DeployContext): Promise<DeployOutput> => {
  const env = opts.env ?? process.env;
  const secrets = secretNamesOf(registry);
  const missingSecrets = secrets.filter((name) => !Object.hasOwn(env, name) || !env[name]);
  const { accountId, cf } = await resolveAuth(opts, env, missingSecrets);

  const scriptName = SCRIPT_NAME;
  const contents = await build(registry, opts, secrets);

  opts.onProgress?.({ step: "deploy", status: "start" });
  type ScriptMetadata = Parameters<CloudflareApi["workers"]["scripts"]["update"]>[1]["metadata"];
  await cf.workers.scripts.update(scriptName, {
    account_id: accountId,
    metadata: {
      main_module: "worker.js",
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "worker_loader" as const, name: LOADER_BINDING },
        {
          type: "workflow" as const,
          name: WORKFLOW_BINDING,
          workflow_name: WORKFLOW_NAME,
          class_name: DYNAMIC_WORKFLOW_CLASS,
        },
        ...secrets.map((name) => ({
          type: "secret_text" as const,
          name,
          text: env[name]!,
        })),
      ],
    } as ScriptMetadata,
    files: [await toFile(contents, "worker.js", { type: "application/javascript+module" })],
  });

  await cf.workflows.update(WORKFLOW_NAME, {
    account_id: accountId,
    class_name: DYNAMIC_WORKFLOW_CLASS,
    script_name: scriptName,
  });

  await cf.workers.scripts.schedules.update(scriptName, {
    account_id: accountId,
    body: cronsOf(registry).map((cron) => ({ cron })),
  });

  const deployed = resultOf(await cf.workflows.list({ account_id: accountId }));
  for (const wf of Array.isArray(deployed)
    ? (deployed as ReadonlyArray<{ name?: string; script_name?: string }>)
    : []) {
    if (wf.script_name === scriptName && typeof wf.name === "string" && wf.name !== WORKFLOW_NAME) {
      await cf.workflows.delete(wf.name, { account_id: accountId });
    }
  }

  await cf.workers.scripts.subdomain.create(scriptName, { account_id: accountId, enabled: true });
  const account = resultOf(await cf.workers.subdomains.get({ account_id: accountId })) as {
    subdomain?: string;
  } | null;
  if (typeof account?.subdomain !== "string" || account.subdomain.length === 0) {
    throw new Error(
      "no workers.dev subdomain on this account: register one in the Cloudflare dashboard",
    );
  }
  const host = `${scriptName}.${account.subdomain}.workers.dev`;
  const urls = registry.flatMap((w) =>
    w.def.trigger.type === "webhook"
      ? [{ id: w.def.id, url: `https://${host}${w.def.trigger.path}` }]
      : [],
  );

  opts.onProgress?.({ step: "deploy", status: "done" });
  return { script: scriptName, urls };
};
