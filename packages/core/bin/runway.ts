#!/usr/bin/env node
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { defineCommand, runMain } from "citty";

import pkg from "../package.json" with { type: "json" };
import { validateTrigger } from "../src/trigger.ts";
import type { ProgressEvent, Registry, RunwayConfig, WorkflowDefinition } from "../src/types.ts";
import { validateSecrets } from "../src/workflow.ts";

const LABELS: Record<ProgressEvent["step"], Record<ProgressEvent["status"], string>> = {
  load: { start: "Loading", done: "Loaded" },
  build: { start: "Building", done: "Built" },
  deploy: { start: "Deploying", done: "Deployed" },
};

const spinner = () => {
  const frames = [".  ", ".. ", "..."];
  let timer: NodeJS.Timeout | undefined;
  let i = 0;
  const clear = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    process.stderr.write("\r\x1b[K");
  };
  return {
    event(event: ProgressEvent) {
      const label = LABELS[event.step][event.status];
      if (!process.stderr.isTTY) {
        console.error(event.status === "start" ? `${label}...` : `${label}.`);
        return;
      }
      clear();
      if (event.status === "start") {
        process.stderr.write(`${label}${frames[0]}\r`);
        timer = setInterval(() => {
          i = (i + 1) % frames.length;
          process.stderr.write(`${label}${frames[i]}\r`);
        }, 80);
      } else {
        console.error(`${label}.`);
      }
    },
    fail(message: string) {
      clear();
      console.error("runway: deploy failed");
      console.error(`  ${message}`);
    },
  };
};

const isWorkflow = (value: unknown): value is WorkflowDefinition =>
  typeof value === "object" &&
  value !== null &&
  (value as { __kind?: unknown }).__kind === "workflow" &&
  Array.isArray((value as { secrets?: unknown }).secrets);

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
      if (!isWorkflow(mod.default)) {
        throw new Error(`${path}: expected "export default createWorkflow(...)"`);
      }
      validateTrigger(mod.default.trigger);
      validateSecrets(mod.default.secrets);
      return { path, def: mod.default };
    }),
  );
  const ids = new Set<string>();
  for (const { def, path } of registry) {
    if (ids.has(def.id)) throw new Error(`duplicate workflow id "${def.id}" (${path})`);
    ids.add(def.id);
  }
  return registry;
};

const deploy = defineCommand({
  meta: { name: "deploy", description: "Build and deploy all registered workflows" },
  async run() {
    const out = spinner();
    try {
      const cwd = process.cwd();
      out.event({ step: "load", status: "start" });
      const config = await loadConfig(cwd);
      const registry = await loadRegistry(cwd, config.workflows);
      out.event({ step: "load", status: "done" });
      const result = await config.backend.deploy(registry, {
        cwd,
        outDir: join(cwd, ".runway"),
        env: process.env,
        onProgress: (event) => out.event(event),
      });
      console.log(`Deployed ${registry.length} workflow(s) as ${result.script}`);
      for (const { id, url } of result.urls) {
        console.log(`  ${id}: POST ${url}`);
      }
    } catch (err) {
      out.fail(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  },
});

await runMain(
  defineCommand({
    meta: { name: "runway", version: pkg.version, description: "Deploy code-first workflows" },
    subCommands: { deploy },
  }),
);
