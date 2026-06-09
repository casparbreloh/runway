import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

import { bindingOf, classOf, generateWorker } from "./codegen.ts";

const scriptNameOf = async (cwd: string): Promise<string> => {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as {
      name?: string;
    };
    const name = (pkg.name ?? "")
      .replace(/^@[^/]+\//, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return name.length > 0 ? name : "runway-app";
  } catch {
    return "runway-app";
  }
};

const build = async (registry: Registry, opts: BuildOptions): Promise<BuildResult> => {
  await mkdir(opts.outDir, { recursive: true });
  const entry = path.join(opts.outDir, "worker.gen.ts");
  await writeFile(entry, generateWorker(registry, opts));
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*"],
    write: false,
  });
  await writeFile(path.join(opts.outDir, "worker.js"), result.outputFiles[0]!.contents);
  return { entry };
};

const deploy = async (registry: Registry, opts: DeployOptions): Promise<DeployResult> => {
  await build(registry, opts);

  const env = opts.env ?? {};
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required");
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");

  const contents = await readFile(path.join(opts.outDir, "worker.js"));
  const scriptName = await scriptNameOf(opts.cwd);
  const cf = new Cloudflare({ apiToken });

  await cf.workers.scripts.update(scriptName, {
    account_id: accountId,
    metadata: {
      main_module: "worker.js",
      compatibility_date: "2026-06-06",
      bindings: registry.map((w) => ({
        type: "workflow" as const,
        name: bindingOf(w.def.id),
        workflow_name: w.def.id,
        class_name: classOf(w.def.id),
      })),
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

  return { ok: true };
};

export const cloudflare = (): Backend => ({ name: "cloudflare", build, deploy });
