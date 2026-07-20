#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { defineCommand, runMain } from "citty";
import { toFile } from "cloudflare";

import pkg from "../package.json" with { type: "json" };
import { resolveAuth } from "../src/internal/auth.ts";
import { deploymentNameOf } from "../src/internal/publish/name.ts";
import {
  COMPATIBILITY_DATE,
  isSecretSnapshotKeyBinding,
} from "../src/internal/runtime/contract.ts";
import { setScriptSecret } from "../src/internal/secret/store.ts";
import { resolveRepositorySource } from "../src/internal/source/repository.ts";
import { validateSecrets } from "../src/workflow.ts";

const EXAMPLE_WORKFLOW = `import { manual, workflow } from "runway";

export default workflow({
  id: "example",
  trigger: () => manual(),
}).run(async (step) => {
  await step.exec("echo", 'echo "Hello from Runway"');
});
`;

const runInit = async (): Promise<void> => {
  const relative = path.join(".runway", "workflows", "example.ts");
  const file = path.resolve(process.cwd(), relative);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, EXAMPLE_WORKFLOW, { flag: "wx" });
    console.log(`Created ${relative}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    console.log(`Preserved ${relative}`);
  }
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

const interactiveCloudAuth = (): boolean => Boolean(process.stdin.isTTY);

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
  const scriptName = deploymentNameOf(await resolveRepositorySource(process.cwd()));
  const { accountId, cf } = await resolveAuth(
    { cwd: process.cwd(), interactive: interactiveCloudAuth() },
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
const init = defineCommand({
  meta: { name: "init", description: "Create an example workflow" },
  async run({ rawArgs }) {
    try {
      if (rawArgs.length > 0) throw new Error("usage: runway init");
      await runInit();
    } catch (err) {
      console.error("runway: init failed");
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  },
});

await runMain(
  defineCommand({
    meta: { name: "runway", version: pkg.version, description: "Run code-first workflows" },
    subCommands: {
      init,
      secrets,
    },
  }),
);
