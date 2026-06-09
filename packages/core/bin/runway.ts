#!/usr/bin/env node
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { defineCommand, runMain } from "citty";

import { validateTrigger } from "../src/trigger.ts";
import type { ProgressEvent, Registry, RunwayConfig, WorkflowDefinition } from "../src/types.ts";

const cwd = (): string => process.cwd();

const labelOf = (step: ProgressEvent["step"], status: ProgressEvent["status"]): string => {
  if (step === "load") return status === "start" ? "Loading" : "Loaded";
  if (step === "build") return status === "start" ? "Building" : "Built";
  return status === "start" ? "Deploying" : "Deployed";
};

const spinner = () => {
  const frames = [".  ", ".. ", "..."];
  let timer: NodeJS.Timeout | undefined;
  let i = 0;
  let label: string | undefined;
  const clear = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    process.stderr.write("\r\x1b[K");
  };
  return {
    event(event: ProgressEvent) {
      const current = labelOf(event.step, event.status);
      if (!process.stderr.isTTY) {
        console.error(event.status === "start" ? `${current}...` : `${current}.`);
        return;
      }
      if (event.status === "start") {
        clear();
        label = current;
        process.stderr.write(`${label}${frames[0]}\r`);
        timer = setInterval(() => {
          i = (i + 1) % frames.length;
          process.stderr.write(`${label}${frames[i]}\r`);
        }, 80);
      } else {
        clear();
        console.error(`${current}.`);
      }
    },
    fail(action: string, message: string) {
      clear();
      console.error(`runway: ${action} failed`);
      console.error(`  ${message}`);
    },
  };
};

const loadConfig = async (cwd: string): Promise<RunwayConfig> => {
  const mod = (await import(pathToFileURL(resolve(cwd, "runway.config.ts")).href)) as {
    default: RunwayConfig;
  };
  return mod.default;
};

const loadRegistry = async (cwd: string, workflows: ReadonlyArray<string>): Promise<Registry> => {
  const registry = await Promise.all(
    workflows.map(async (path) => {
      const mod = (await import(pathToFileURL(resolve(cwd, path)).href)) as { default?: unknown };
      const def = mod.default;
      if ((def as { __kind?: string } | undefined)?.__kind !== "workflow") {
        throw new Error(`${path}: expected "export default createWorkflow(...)"`);
      }
      validateTrigger((def as WorkflowDefinition).trigger);
      return { path, def: def as WorkflowDefinition };
    }),
  );
  const ids = new Set<string>();
  for (const { def, path } of registry) {
    if (ids.has(def.id)) throw new Error(`duplicate workflow id "${def.id}" (${path})`);
    ids.add(def.id);
  }
  return registry;
};

const deploy = async (onProgress: (event: ProgressEvent) => void): Promise<number> => {
  const root = cwd();
  onProgress({ step: "load", status: "start" });
  const config = await loadConfig(root);
  const registry = await loadRegistry(root, config.workflows);
  onProgress({ step: "load", status: "done" });
  await config.backend.deploy(registry, {
    cwd: root,
    outDir: join(root, ".runway"),
    env: process.env,
    onProgress,
  });
  return registry.length;
};

const run = async (): Promise<void> => {
  const out = spinner();
  try {
    const n = await deploy((event) => out.event(event));
    console.log(`Deployed ${n} workflow(s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.fail("deploy", message);
    process.exitCode = 1;
  }
};

const main = defineCommand({
  meta: { name: "runway", version: "0.1.0", description: "Deploy code-first workflows" },
  subCommands: {
    deploy: defineCommand({
      meta: { name: "deploy", description: "Build and deploy all registered workflows" },
      async run() {
        await run();
      },
    }),
  },
});

await runMain(main);
