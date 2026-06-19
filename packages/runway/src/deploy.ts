import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { builtinModules } from "node:module";
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
  SANDBOX_BINDING,
  SANDBOX_CLASS,
  SANDBOX_IMAGE,
  SANDBOX_MIGRATION_TAG,
  WORKFLOW_BINDING,
  cronsOf,
  generateDynamicWorker,
  generateWorker,
} from "./codegen.ts";
import { resolveScriptName } from "./naming.ts";
import { secretNamesOf } from "./registry.ts";
import { listScriptSecrets } from "./secret-store.ts";
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
      list(params: { account_id: string }): Promise<unknown>;
      update: AsyncMethod<Cloudflare["workers"]["scripts"]["update"]>;
      secrets: {
        list(scriptName: string, params: { account_id: string }): Promise<unknown>;
        bulkUpdate(scriptName: string, params: unknown): Promise<unknown>;
      };
      versions: {
        list(
          scriptName: string,
          params: { account_id: string; per_page?: number },
        ): Promise<unknown>;
        get(
          scriptName: string,
          versionId: string,
          params: { account_id: string },
        ): Promise<unknown>;
      };
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
  containers: {
    applications: {
      list(params: { account_id: string }): Promise<unknown>;
      create(params: { account_id: string; body: unknown }): Promise<unknown>;
    };
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
  const containerRequest = async (
    accountId: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers${path}`,
      {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${apiToken}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      },
    );
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      throw new Error(`Cloudflare Containers API ${response.status}: ${text}`);
    }
    return parsed;
  };
  return {
    accounts: cf.accounts,
    workers: cf.workers,
    workflows: cf.workflows,
    containers: {
      applications: {
        list: async ({ account_id }) => containerRequest(account_id, "/applications"),
        create: async ({ account_id, body }) =>
          containerRequest(account_id, "/applications", { method: "POST", body }),
      },
    },
  };
};

const resultOf = (response: unknown): unknown =>
  response && typeof response === "object" && "result" in response
    ? (response as { result: unknown }).result
    : response;

const execFileAsync = promisify(execFile);

const validateBindings = (secrets: ReadonlyArray<string>): void => {
  const names = new Map<string, string>();
  names.set(WORKFLOW_BINDING, "Runway workflow binding");
  names.set(LOADER_BINDING, "Runway worker loader binding");
  names.set(SANDBOX_BINDING, "Runway sandbox binding");
  for (const secret of secrets) {
    const owner = names.get(secret);
    if (owner) {
      throw new Error(`binding ${JSON.stringify(secret)} is used by ${owner} and a secret`);
    }
  }
};

const wranglerTokenOf = async (
  opts: DeployContext,
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

const currentMigrationTagOf = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
): Promise<string | undefined> => {
  const collect = (item: unknown): string | undefined => {
    if (!item || typeof item !== "object") return undefined;
    const script = item as { id?: unknown; migration_tag?: unknown };
    return script.id === scriptName && typeof script.migration_tag === "string"
      ? script.migration_tag
      : undefined;
  };
  const response = await cf.workers.scripts.list({ account_id: accountId });
  const result = resultOf(response);
  if (Array.isArray(result)) {
    for (const item of result) {
      const tag = collect(item);
      if (tag) return tag;
    }
  }
  if (response && typeof response === "object" && Symbol.asyncIterator in response) {
    for await (const item of response as AsyncIterable<unknown>) {
      const tag = collect(item);
      if (tag) return tag;
    }
  }
  return undefined;
};

const firstIdOf = async (response: unknown): Promise<string | undefined> => {
  const collect = (item: unknown): string | undefined =>
    item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
      ? (item as { id: string }).id
      : undefined;
  const result = resultOf(response);
  if (Array.isArray(result)) {
    for (const item of result) {
      const id = collect(item);
      if (id) return id;
    }
  }
  if (response && typeof response === "object" && Symbol.asyncIterator in response) {
    for await (const item of response as AsyncIterable<unknown>) {
      const id = collect(item);
      if (id) return id;
    }
  }
  return undefined;
};

const sandboxNamespaceIdOf = (version: unknown): string | undefined => {
  const bindings =
    version && typeof version === "object"
      ? (version as { resources?: { bindings?: ReadonlyArray<unknown> } }).resources?.bindings
      : undefined;
  const binding = bindings?.find(
    (b) =>
      b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "durable_object_namespace" &&
      (b as { name?: unknown }).name === SANDBOX_BINDING &&
      (b as { class_name?: unknown }).class_name === SANDBOX_CLASS,
  );
  return binding && typeof (binding as { namespace_id?: unknown }).namespace_id === "string"
    ? (binding as { namespace_id: string }).namespace_id
    : undefined;
};

const deploySandboxContainer = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
): Promise<void> => {
  const versionId = await firstIdOf(
    await cf.workers.scripts.versions.list(scriptName, { account_id: accountId, per_page: 1 }),
  );
  if (!versionId) throw new Error(`missing Worker version after deploy: ${scriptName}`);
  const namespaceId = sandboxNamespaceIdOf(
    resultOf(
      await cf.workers.scripts.versions.get(scriptName, versionId, { account_id: accountId }),
    ),
  );
  if (!namespaceId) throw new Error(`missing sandbox durable object namespace: ${SANDBOX_BINDING}`);

  const appName = `${scriptName}-${SANDBOX_CLASS}`;
  const apps = resultOf(await cf.containers.applications.list({ account_id: accountId }));
  const existing = Array.isArray(apps)
    ? apps.find(
        (app) => app && typeof app === "object" && (app as { name?: unknown }).name === appName,
      )
    : undefined;
  if (existing) {
    const existingNamespace = (existing as { durable_objects?: { namespace_id?: unknown } })
      .durable_objects?.namespace_id;
    if (existingNamespace !== namespaceId) {
      throw new Error(
        `container application ${appName} is attached to a different durable object namespace`,
      );
    }
    return;
  }

  await cf.containers.applications.create({
    account_id: accountId,
    body: {
      name: appName,
      scheduling_policy: "default",
      configuration: {
        image: SANDBOX_IMAGE,
        instance_type: "lite",
      },
      instances: 0,
      max_instances: 20,
      constraints: { tiers: [1, 2] },
      durable_objects: { namespace_id: namespaceId },
      rollout_active_grace_period: 0,
    },
  });
};

export const resolveAuth = async (
  opts: DeployContext,
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
    build.onResolve({ filter: /^@cloudflare\/sandbox$/ }, () => ({
      path: path.resolve(import.meta.dirname, "../node_modules/@cloudflare/sandbox/dist/index.js"),
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
  const scriptName = await resolveScriptName({ cwd: opts.cwd, env });
  const workflowName = scriptName;
  const { accountId, cf } = await resolveAuth(opts, env);
  const remoteSecrets = await listScriptSecrets(cf, accountId, scriptName);
  const missingSecrets = registry.flatMap((w) =>
    w.def.secrets
      .filter((name) => !env[name] && !remoteSecrets.has(name))
      .map((name) => `${w.def.id}.${name}`),
  );
  if (missingSecrets.length > 0) {
    throw new Error(`missing secret(s): ${missingSecrets.join(", ")}`);
  }
  validateBindings(secrets);
  const localSecretBindings = secrets.filter((name) => env[name]);
  const contents = await build(registry, opts, localSecretBindings);
  const migrationTag = await currentMigrationTagOf(cf, accountId, scriptName);

  opts.onProgress?.({ step: "deploy", status: "start" });
  type ScriptMetadata = Parameters<CloudflareApi["workers"]["scripts"]["update"]>[1]["metadata"];
  type ScriptMetadataWithContainers = ScriptMetadata & {
    containers?: ReadonlyArray<{
      class_name: string;
      image: string;
      instance_type?: string;
      max_instances?: number;
    }>;
  };
  await cf.workers.scripts.update(scriptName, {
    account_id: accountId,
    metadata: {
      main_module: "worker.js",
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: ["nodejs_compat"],
      keep_bindings: ["secret_text"],
      bindings: [
        { type: "worker_loader" as const, name: LOADER_BINDING },
        {
          type: "workflow" as const,
          name: WORKFLOW_BINDING,
          workflow_name: workflowName,
          class_name: DYNAMIC_WORKFLOW_CLASS,
        },
        {
          type: "durable_object_namespace" as const,
          name: SANDBOX_BINDING,
          class_name: SANDBOX_CLASS,
        },
        ...localSecretBindings.map((name) => ({
          type: "secret_text" as const,
          name,
          text: env[name]!,
        })),
      ],
      containers: [
        {
          class_name: SANDBOX_CLASS,
          image: SANDBOX_IMAGE,
          instance_type: "lite",
        },
      ],
      ...(migrationTag === SANDBOX_MIGRATION_TAG
        ? {}
        : {
            migrations: {
              ...(migrationTag ? { old_tag: migrationTag } : {}),
              new_tag: SANDBOX_MIGRATION_TAG,
              new_sqlite_classes: [SANDBOX_CLASS],
            },
          }),
    } as ScriptMetadataWithContainers,
    files: [await toFile(contents, "worker.js", { type: "application/javascript+module" })],
  });
  await deploySandboxContainer(cf, accountId, scriptName);

  await cf.workflows.update(workflowName, {
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
    if (wf.script_name === scriptName && typeof wf.name === "string" && wf.name !== workflowName) {
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
