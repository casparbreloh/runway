import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type {
  Backend,
  BuildOptions,
  BuildResult,
  DeployOptions,
  DeployResult,
  Registry,
} from "@runway/core";
import Cloudflare, { toFile } from "cloudflare";
import { build as esbuild } from "esbuild";

import { generateWorker, generateWranglerConfig } from "./codegen.ts";
import { bindingOf, classOf } from "./ids.ts";

type AsyncMethod<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<Awaited<ReturnType<T>>>;

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
    registry
      .map((w) => w.def.trigger)
      .filter((trigger) => trigger.type === "webhook")
      .map((trigger) => trigger.auth.secret),
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

const build = async (registry: Registry, opts: BuildOptions): Promise<BuildResult> => {
  validateBindings(registry);
  opts.onProgress?.({ step: "build", status: "start" });
  await mkdir(opts.outDir, { recursive: true });
  const entry = path.join(opts.outDir, "worker.gen.ts");
  await writeFile(entry, generateWorker(registry, opts));
  await writeFile(
    path.join(opts.outDir, "wrangler.jsonc"),
    generateWranglerConfig(registry, {
      name: await scriptNameOf(opts.cwd),
      main: path.basename(entry),
    }),
  );
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*"],
    write: false,
  });
  await writeFile(path.join(opts.outDir, "worker.js"), result.outputFiles[0]!.contents);
  opts.onProgress?.({ step: "build", status: "done" });
  return { entry };
};

const deploy =
  (backendOpts: CloudflareBackendOptions = {}) =>
  async (registry: Registry, opts: DeployOptions): Promise<DeployResult> => {
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

    await build(registry, opts);

    const contents = await readFile(path.join(opts.outDir, "worker.js"));
    const scriptName = await scriptNameOf(opts.cwd);
    const cf = backendOpts.client?.({ apiToken }) ?? new Cloudflare({ apiToken });

    opts.onProgress?.({ step: "deploy", status: "start" });
    await cf.workers.scripts.update(scriptName, {
      account_id: accountId,
      metadata: {
        main_module: "worker.js",
        compatibility_date: "2026-06-06",
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

    const schedules = registry
      .map((w) => w.def.trigger)
      .filter((trigger) => trigger.type === "cron")
      .map((trigger) => ({ cron: trigger.cron }));
    await cf.workers.scripts.schedules.update(scriptName, {
      account_id: accountId,
      body: schedules,
    });

    opts.onProgress?.({ step: "deploy", status: "done" });
    return { ok: true };
  };

export const cloudflare = (opts: CloudflareBackendOptions = {}): Backend => ({
  name: "cloudflare",
  build,
  deploy: deploy(opts),
});
