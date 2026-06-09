#!/usr/bin/env node
import process from "node:process";

import { defineCommand, runMain } from "citty";

import { build, deploy } from "../cli/run.ts";
import type { ProgressEvent } from "../src/types.ts";

const cwd = (): string => process.cwd();

const labelOf = (step: ProgressEvent["step"]): string => (step === "build" ? "Build" : "Deploy");

const spinner = () => {
  const frames = ["-", "\\", "|", "/"];
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
      if (!process.stderr.isTTY) {
        console.error(`${labelOf(event.step)} ${event.status === "start" ? "..." : "done"}`);
        return;
      }
      if (event.status === "start") {
        clear();
        label = labelOf(event.step);
        process.stderr.write(`${frames[0]} ${label}\r`);
        timer = setInterval(() => {
          i = (i + 1) % frames.length;
          process.stderr.write(`${frames[i]} ${label}\r`);
        }, 80);
      } else {
        clear();
        console.error(`ok ${labelOf(event.step)}`);
      }
    },
    fail(action: string, message: string) {
      clear();
      console.error(`runway: ${action} failed`);
      console.error(`  ${message}`);
    },
  };
};

const run = async (
  action: "build" | "deploy",
  fn: (onProgress: (event: ProgressEvent) => void) => Promise<number>,
): Promise<void> => {
  const out = spinner();
  try {
    const n = await fn((event) => out.event(event));
    console.log(`${action === "deploy" ? "Deployed" : "Built"} ${n} workflow(s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    out.fail(action, message);
    process.exitCode = 1;
  }
};

const main = defineCommand({
  meta: { name: "runway", version: "0.1.0", description: "Deploy code-first workflows" },
  subCommands: {
    deploy: defineCommand({
      meta: { name: "deploy", description: "Build and deploy all registered workflows" },
      async run() {
        await run("deploy", (onProgress) => deploy(cwd(), onProgress));
      },
    }),
    build: defineCommand({
      meta: { name: "build", description: "Generate and bundle the Worker without deploying" },
      async run() {
        await run("build", (onProgress) => build(cwd(), onProgress));
      },
    }),
  },
});

await runMain(main);
