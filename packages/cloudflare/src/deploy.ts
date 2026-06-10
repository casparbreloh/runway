import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { Backend, DeployOptions, Registry } from "@runway/core";
import Cloudflare, { toFile } from "cloudflare";
import { build as esbuild } from "esbuild";

import { COMPATIBILITY_DATE, cronsOf, generateWorker, generateWranglerConfig } from "./codegen.ts";
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
    };
  };
  workflows: {
    update: AsyncMethod<Cloudflare["workflows"]["update"]>;
  };
};

export type CloudflareBackendOptions = {
  client?(opts: { apiToken: string }): CloudflareApi;
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
    if (project.length === 0 || project === "example") return "runway";
    return `runway-${project}`;
  } catch {
    return "runway";
  }
};

const secretNamesOf = (registry: Registry): ReadonlyArray<string> => [
  ...new Set(
    registry.flatMap((w) => (w.def.trigger.type === "webhook" ? [w.def.trigger.auth.secret] : [])),
  ),
];

const validateBindings = (registry: Registry): void => {
  const names = new Map<string, string>();
  for (const w of registry) {
    names.set(bindingOf(w.def.id), `workflow ${JSON.stringify(w.def.id)}`);
  }
  for (const secret of secretNamesOf(registry)) {
    const owner = names.get(secret);
    if (owner) {
      throw new Error(`binding ${JSON.stringify(secret)} is used by ${owner} and a webhook secret`);
    }
    names.set(secret, "webhook secret");
  }
};

const build = async (
  registry: Registry,
  opts: DeployOptions,
  scriptName: string,
): Promise<Uint8Array> => {
  validateBindings(registry);
  opts.onProgress?.({ step: "build", status: "start" });
  await mkdir(opts.outDir, { recursive: true });
  const entry = path.join(opts.outDir, "worker.gen.ts");
  await writeFile(entry, generateWorker(registry, opts));
  await writeFile(
    path.join(opts.outDir, "wrangler.jsonc"),
    generateWranglerConfig(registry, { name: scriptName, main: path.basename(entry) }),
  );
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*"],
    write: false,
  });
  const contents = result.outputFiles[0]!.contents;
  await writeFile(path.join(opts.outDir, "worker.js"), contents);
  opts.onProgress?.({ step: "build", status: "done" });
  return contents;
};

const deploy = async (
  registry: Registry,
  opts: DeployOptions,
  backendOpts: CloudflareBackendOptions,
): Promise<void> => {
  const env = opts.env ?? process.env;
  const secrets = secretNamesOf(registry);
  const missingEnv = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", ...secrets].filter(
    (name) => !env[name],
  );
  if (missingEnv.length > 0) {
    throw new Error(`missing required env var(s): ${missingEnv.join(", ")}`);
  }
  const apiToken = env.CLOUDFLARE_API_TOKEN!;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID!;

  const scriptName = await scriptNameOf(opts.cwd);
  const contents = await build(registry, opts, scriptName);
  const cf: CloudflareApi = backendOpts.client?.({ apiToken }) ?? new Cloudflare({ apiToken });

  opts.onProgress?.({ step: "deploy", status: "start" });
  await cf.workers.scripts.update(scriptName, {
    account_id: accountId,
    metadata: {
      main_module: "worker.js",
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [
        ...registry.map((w) => ({
          type: "workflow" as const,
          name: bindingOf(w.def.id),
          workflow_name: w.def.id,
          class_name: classOf(w.def.id),
        })),
        ...secrets.map((name) => ({
          type: "secret_text" as const,
          name,
          text: env[name]!,
        })),
      ],
    },
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
  opts.onProgress?.({ step: "deploy", status: "done" });
};

export const cloudflare = (backendOpts: CloudflareBackendOptions = {}): Backend => ({
  deploy: (registry, opts) => deploy(registry, opts, backendOpts),
});
