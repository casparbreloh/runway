#!/usr/bin/env node
import process from "node:process";

import { defineCommand, runMain } from "citty";

import pkg from "../package.json" with { type: "json" };
import { deploy as deployCloudflare } from "../src/deploy.ts";
import { loadRegistry } from "../src/registry.ts";
import type { ProgressEvent } from "../src/types.ts";

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

const deploy = defineCommand({
  meta: { name: "deploy", description: "Build and deploy all registered workflows" },
  async run() {
    const out = spinner();
    try {
      const cwd = process.cwd();
      out.event({ step: "load", status: "start" });
      const registry = await loadRegistry(cwd);
      out.event({ step: "load", status: "done" });
      const result = await deployCloudflare(registry, {
        cwd,
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
