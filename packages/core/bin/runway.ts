#!/usr/bin/env node
import process from "node:process";

import { defineCommand, runMain } from "citty";

import { build, deploy } from "../cli/run.ts";

const cwd = (): string => process.cwd();

const main = defineCommand({
  meta: { name: "runway", version: "0.1.0", description: "Deploy code-first workflows" },
  subCommands: {
    deploy: defineCommand({
      meta: { name: "deploy", description: "Build and deploy all registered workflows" },
      async run() {
        const n = await deploy(cwd());
        console.log(`runway: deployed ${n} workflow(s)`);
      },
    }),
    build: defineCommand({
      meta: { name: "build", description: "Generate and bundle the Worker without deploying" },
      async run() {
        const n = await build(cwd());
        console.log(`runway: built ${n} workflow(s)`);
      },
    }),
  },
});

await runMain(main);
