#!/usr/bin/env node
import process from "node:process";

import { defineCommand, runMain } from "citty";

import { check, deploy, dev, secret, typegen } from "../cli/run.ts";

const cwd = (): string => process.cwd();

const deployCmd = defineCommand({
  meta: { name: "deploy", description: "Type-check and deploy all workflows to Cloudflare" },
  async run() {
    const n = await deploy(cwd());
    console.log(`runway: deployed ${n} workflow(s)`);
  },
});

const checkCmd = defineCommand({
  meta: { name: "check", description: "Type-check and build the Worker without deploying" },
  async run() {
    const n = await check(cwd());
    console.log(`runway: ${n} workflow(s) ok`);
  },
});

const typegenCmd = defineCommand({
  meta: { name: "typegen", description: "Generate the Worker, wrangler config and env types" },
  async run() {
    const n = await typegen(cwd());
    console.log(`runway: generated ${n} workflow(s)`);
  },
});

const devCmd = defineCommand({
  meta: { name: "dev", description: "Run the workflows locally with wrangler dev" },
  async run() {
    await dev(cwd());
  },
});

const secretCmd = defineCommand({
  meta: { name: "secret", description: "Manage Cloudflare secrets" },
  subCommands: {
    put: defineCommand({
      meta: { name: "put", description: "Set a secret value (wrangler prompts for it)" },
      args: { name: { type: "positional", description: "Secret name", required: true } },
      async run({ args }) {
        await secret(cwd(), args.name);
      },
    }),
  },
});

const main = defineCommand({
  meta: {
    name: "runway",
    version: "0.1.0",
    description: "Deploy code-first workflows to Cloudflare",
  },
  subCommands: {
    deploy: deployCmd,
    check: checkCmd,
    typegen: typegenCmd,
    dev: devCmd,
    secret: secretCmd,
  },
});

await runMain(main);
