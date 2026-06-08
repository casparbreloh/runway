import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";

import { generate } from "./codegen.ts";
import { discover } from "./discover.ts";

const require = createRequire(import.meta.url);

const resolveBin = (spec: string, name: string): string => {
  const pkg = require.resolve(`${spec}/package.json`);
  const bin = (JSON.parse(readFileSync(pkg, "utf8")) as { bin?: string | Record<string, string> })
    .bin;
  const rel = typeof bin === "string" ? bin : bin?.[name];
  if (!rel) throw new Error(`cannot locate ${name} executable`);
  return join(dirname(pkg), rel);
};

interface Run {
  readonly code: number;
  readonly spawned: boolean;
}

const exec = (cmd: string, args: string[], cwd: string): Promise<Run> =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", () => resolve({ code: 1, spawned: false }));
    child.on("exit", (code) => resolve({ code: code ?? 1, spawned: true }));
  });

const wrangler = (cwd: string, ...args: string[]): Promise<Run> =>
  exec(
    process.execPath,
    [resolveBin("wrangler", "wrangler"), "--config", ".runway/wrangler.gen.jsonc", ...args],
    cwd,
  );

const typecheck = async (cwd: string): Promise<number> => {
  const tsgo = await exec("tsgo", ["--noEmit"], cwd);
  if (tsgo.spawned) return tsgo.code;
  const tsc = await exec("tsc", ["--noEmit"], cwd);
  if (tsc.spawned) return tsc.code;
  console.warn("runway: no typechecker (tsgo/tsc) found — skipping type check");
  return 0;
};

const gate = (code: number, message: string): void => {
  if (code !== 0) throw new Error(message);
};

export const typegen = async (cwd: string): Promise<number> => {
  const defs = await discover(cwd);
  await generate(cwd, defs);
  return defs.length;
};

export const check = async (cwd: string): Promise<number> => {
  const n = await typegen(cwd);
  gate(await typecheck(cwd), "type check failed");
  gate(
    (await wrangler(cwd, "deploy", "--dry-run", "--outdir", ".runway/dry")).code,
    "worker build failed",
  );
  return n;
};

export const deploy = async (cwd: string): Promise<number> => {
  const n = await typegen(cwd);
  gate(await typecheck(cwd), "type check failed — not deploying");
  gate((await wrangler(cwd, "deploy")).code, "wrangler deploy failed");
  return n;
};

export const dev = async (cwd: string): Promise<void> => {
  await typegen(cwd);
  await wrangler(cwd, "dev");
};

export const secret = async (cwd: string, name: string): Promise<void> => {
  await typegen(cwd);
  gate((await wrangler(cwd, "secret", "put", name)).code, "wrangler secret put failed");
};
