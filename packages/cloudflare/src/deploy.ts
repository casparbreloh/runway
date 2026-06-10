import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import process from "node:process";

import type { Backend, DeployOptions, DeployResult, Registry } from "@runway/core";
import Cloudflare, { toFile } from "cloudflare";
import { build as esbuild } from "esbuild";

import {
  COMPATIBILITY_DATE,
  cronsOf,
  generateWorker,
  SANDBOX_CLASS,
  SANDBOX_IMAGE,
} from "./codegen.ts";
import { bindingOf, classOf } from "./naming.ts";

type AsyncMethod<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<unknown>;

export type CloudflareApi = {
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
  durableObjects: {
    namespaces: {
      list(params: { account_id: string }): Promise<unknown>;
    };
  };
  containers: {
    applications: {
      list(params: { account_id: string }): Promise<unknown>;
      create(params: { account_id: string; body: unknown }): Promise<unknown>;
      update(id: string, params: { account_id: string; body: unknown }): Promise<unknown>;
    };
  };
};

export type CloudflareBackendOptions = {
  client?(opts: { apiToken: string }): CloudflareApi;
  sandbox?: boolean;
};

const defaultClient = (apiToken: string): CloudflareApi => {
  const cf = new Cloudflare({ apiToken });
  return {
    workers: cf.workers,
    workflows: cf.workflows,
    durableObjects: cf.durableObjects,
    containers: {
      applications: {
        list: ({ account_id }) => cf.get(`/accounts/${account_id}/containers/applications`),
        create: ({ account_id, body }) =>
          cf.post(`/accounts/${account_id}/containers/applications`, { body }),
        update: (id, { account_id, body }) =>
          cf.patch(`/accounts/${account_id}/containers/applications/${id}`, { body }),
      },
    },
  };
};

const resultOf = (response: unknown): unknown =>
  response && typeof response === "object" && "result" in response
    ? (response as { result: unknown }).result
    : response;

const sandboxNamespaceOf = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
): Promise<string | undefined> => {
  const namespaces = resultOf(await cf.durableObjects.namespaces.list({ account_id: accountId }));
  if (!Array.isArray(namespaces)) return undefined;
  const match = (
    namespaces as ReadonlyArray<{ id?: string; class?: string; script?: string }>
  ).find((ns) => ns.script === scriptName && ns.class === SANDBOX_CLASS);
  return typeof match?.id === "string" ? match.id : undefined;
};

const upsertSandboxApplication = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
  namespaceId: string,
): Promise<void> => {
  const name = `${scriptName}-sandbox`;
  const configuration = { image: SANDBOX_IMAGE, instance_type: "basic" };
  const applications = resultOf(await cf.containers.applications.list({ account_id: accountId }));
  const existing = (
    Array.isArray(applications)
      ? (applications as ReadonlyArray<{
          id?: string;
          name?: string;
          configuration?: { image?: string };
        }>)
      : []
  ).find((app) => app.name === name);
  if (!existing?.id) {
    await cf.containers.applications.create({
      account_id: accountId,
      body: {
        name,
        scheduling_policy: "default",
        instances: 0,
        max_instances: 5,
        durable_objects: { namespace_id: namespaceId },
        configuration,
      },
    });
    return;
  }
  if (existing.configuration?.image !== SANDBOX_IMAGE) {
    await cf.containers.applications.update(existing.id, {
      account_id: accountId,
      body: { configuration },
    });
  }
};

const scriptNameOf = async (cwd: string): Promise<string> => {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as {
      name?: string;
    };
    const project = (pkg.name ?? "")
      .replace(/^@[^/]+\//, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (project.length === 0) return "runway";
    return `runway-${project}`;
  } catch {
    return "runway";
  }
};

const secretNamesOf = (registry: Registry): ReadonlyArray<string> => [
  ...new Set(registry.flatMap((w) => w.def.secrets)),
];

const validateBindings = (registry: Registry): void => {
  const names = new Map<string, string>();
  for (const w of registry) {
    names.set(bindingOf(w.def.id), `workflow ${JSON.stringify(w.def.id)}`);
  }
  for (const secret of secretNamesOf(registry)) {
    const owner = names.get(secret);
    if (owner) {
      throw new Error(`binding ${JSON.stringify(secret)} is used by ${owner} and a secret`);
    }
  }
};

const build = async (
  registry: Registry,
  opts: DeployOptions,
  sandbox: boolean,
): Promise<Uint8Array> => {
  validateBindings(registry);
  opts.onProgress?.({ step: "build", status: "start" });
  const entry = path.join(opts.cwd, "worker.gen.ts");
  const worker = generateWorker(registry, { cwd: opts.cwd, outDir: opts.cwd, sandbox });
  const result = await esbuild({
    entryPoints: ["runway:worker"],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*", "node:*", ...builtinModules],
    write: false,
    plugins: [
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
  const contents = result.outputFiles[0]!.contents;
  opts.onProgress?.({ step: "build", status: "done" });
  return contents;
};

const deploy = async (
  registry: Registry,
  opts: DeployOptions,
  backendOpts: CloudflareBackendOptions,
): Promise<DeployResult> => {
  const env = opts.env ?? process.env;
  const secrets = secretNamesOf(registry);
  const missingEnv = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", ...secrets].filter(
    (name) => !Object.hasOwn(env, name) || !env[name],
  );
  if (missingEnv.length > 0) {
    throw new Error(`missing required env var(s): ${missingEnv.join(", ")}`);
  }
  const apiToken = env.CLOUDFLARE_API_TOKEN!;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID!;

  const sandbox = backendOpts.sandbox === true;
  const scriptName = await scriptNameOf(opts.cwd);
  const contents = await build(registry, opts, sandbox);
  const cf: CloudflareApi = backendOpts.client?.({ apiToken }) ?? defaultClient(apiToken);

  opts.onProgress?.({ step: "deploy", status: "start" });
  const existingNamespace = sandbox
    ? await sandboxNamespaceOf(cf, accountId, scriptName)
    : undefined;
  type ScriptMetadata = Parameters<CloudflareApi["workers"]["scripts"]["update"]>[1]["metadata"];
  await cf.workers.scripts.update(scriptName, {
    account_id: accountId,
    metadata: {
      main_module: "worker.js",
      compatibility_date: COMPATIBILITY_DATE,
      compatibility_flags: ["nodejs_compat"],
      ...(sandbox
        ? {
            containers: [{ class_name: SANDBOX_CLASS }],
            ...(existingNamespace
              ? {}
              : { migrations: { new_tag: "v1", new_sqlite_classes: [SANDBOX_CLASS] } }),
          }
        : {}),
      bindings: [
        ...registry.map((w) => ({
          type: "workflow" as const,
          name: bindingOf(w.def.id),
          workflow_name: w.def.id,
          class_name: classOf(w.def.id),
        })),
        ...(sandbox
          ? [
              {
                type: "durable_object_namespace" as const,
                name: SANDBOX_CLASS,
                class_name: SANDBOX_CLASS,
              },
            ]
          : []),
        ...secrets.map((name) => ({
          type: "secret_text" as const,
          name,
          text: env[name]!,
        })),
      ],
    } as ScriptMetadata,
    files: [await toFile(contents, "worker.js", { type: "application/javascript+module" })],
  });

  for (const w of registry) {
    await cf.workflows.update(w.def.id, {
      account_id: accountId,
      class_name: classOf(w.def.id),
      script_name: scriptName,
    });
  }

  await cf.workers.scripts.schedules.update(scriptName, {
    account_id: accountId,
    body: cronsOf(registry).map((cron) => ({ cron })),
  });

  const deployed = resultOf(await cf.workflows.list({ account_id: accountId }));
  const ids = new Set(registry.map((w) => w.def.id));
  for (const wf of Array.isArray(deployed)
    ? (deployed as ReadonlyArray<{ name?: string; script_name?: string }>)
    : []) {
    if (wf.script_name === scriptName && typeof wf.name === "string" && !ids.has(wf.name)) {
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

  if (sandbox) {
    const namespaceId = existingNamespace ?? (await sandboxNamespaceOf(cf, accountId, scriptName));
    if (!namespaceId) {
      throw new Error(`missing durable object namespace for class ${SANDBOX_CLASS}`);
    }
    await upsertSandboxApplication(cf, accountId, scriptName, namespaceId);
  }
  opts.onProgress?.({ step: "deploy", status: "done" });
  return { script: scriptName, urls };
};

export const cloudflare = (backendOpts: CloudflareBackendOptions = {}): Backend => ({
  deploy: (registry, opts) => deploy(registry, opts, backendOpts),
});
