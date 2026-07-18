#!/usr/bin/env node
import process from "node:process";

import { defineCommand, runMain } from "citty";
import { toFile } from "cloudflare";

import pkg from "../package.json" with { type: "json" };
import { deploy as deployCloudflare, resolveAuth } from "../src/deploy.ts";
import type { ProgressEvent } from "../src/deploy.ts";
import { resolveScriptName } from "../src/internal/deploy/name.ts";
import { loadRegistry } from "../src/internal/deploy/registry.ts";
import {
  COMPATIBILITY_DATE,
  isSecretSnapshotKeyBinding,
} from "../src/internal/runtime/contract.ts";
import { setScriptSecret } from "../src/internal/secret/store.ts";
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

const parseSecretsSet = (args: ReadonlyArray<string>): { name: string; value: string } => {
  const [name, value, ...extra] = args;
  if (!name || !value || extra.length > 0) {
    throw new Error("usage: runway secrets set <name> <value>");
  }
  validateSecrets([name]);
  if (isSecretSnapshotKeyBinding(name)) {
    throw new Error(`secret ${JSON.stringify(name)} is reserved by Runway`);
  }
  return { name, value };
};

const isMissingScript = (err: unknown): boolean =>
  err instanceof Error &&
  ("status" in err ? (err as { status?: unknown }).status === 404 : /not found/i.test(err.message));

const createPlaceholderScript = async (
  cf: Awaited<ReturnType<typeof resolveAuth>>["cf"],
  accountId: string,
  scriptName: string,
  binding: string,
  value: string,
): Promise<void> => {
  await cf.workers.scripts.update(scriptName, {
    account_id: accountId,
    metadata: {
      main_module: "worker.js",
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [{ type: "secret_text" as const, name: binding, text: value }],
    },
    files: [
      await toFile(
        new TextEncoder().encode(
          'export default { fetch: () => new Response("Runway has not been deployed yet", { status: 404 }) };',
        ),
        "worker.js",
        { type: "application/javascript+module" },
      ),
    ],
  });
};

const runSecrets = async (args: ReadonlyArray<string>): Promise<void> => {
  const [command, ...rest] = args;
  if (command !== "set") throw new Error("usage: runway secrets set <name> <value>");
  const { name, value } = parseSecretsSet(rest);
  const scriptName = await resolveScriptName({
    cwd: process.cwd(),
    env: process.env,
  });
  const { accountId, cf } = await resolveAuth(
    { cwd: process.cwd(), env: process.env },
    process.env,
  );
  try {
    await setScriptSecret(cf, accountId, scriptName, name, value);
  } catch (err) {
    if (!isMissingScript(err)) throw err;
    await createPlaceholderScript(cf, accountId, scriptName, name, value);
  }
  console.log(`Set ${name}`);
};

const secretsSet = defineCommand({
  meta: { name: "set", description: "Set a workflow secret" },
  async run({ rawArgs }) {
    try {
      await runSecrets(["set", ...rawArgs]);
    } catch (err) {
      console.error("runway: secrets failed");
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  },
});

const secrets = defineCommand({
  meta: { name: "secrets", description: "Manage workflow secrets" },
  subCommands: { set: secretsSet },
});
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
    subCommands: { deploy, secrets },
  }),
);
