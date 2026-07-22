#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { defineCommand, runMain } from "citty";
import { toFile } from "cloudflare";

import pkg from "../package.json" with { type: "json" };
import { resolveAuth } from "../src/internal/auth.ts";
import {
  assertCleanWorktree,
  assertWorkersBuildEnvironment,
  connectGitHub,
  releaseFromBuild,
} from "../src/internal/connect.ts";
import { runLocal } from "../src/internal/local.ts";
import { deploymentNameOf } from "../src/internal/publish/name.ts";
import { loadRegistry } from "../src/internal/publish/registry.ts";
import {
  COMPATIBILITY_DATE,
  isSecretSnapshotKeyBinding,
} from "../src/internal/runtime/contract.ts";
import { setScriptSecret } from "../src/internal/secret/store.ts";
import { resolveRepositorySource } from "../src/internal/source/repository.ts";
import { validateSecrets } from "../src/workflow.ts";

const EXAMPLE_WORKFLOW = `import { workflow } from "runway";

export default workflow({ id: "example" }).run(async (step) => {
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

const readEvent = async (file: string | undefined): Promise<unknown> => {
  if (!file) return undefined;
  const contents =
    file === "-"
      ? await (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
          return Buffer.concat(chunks).toString("utf8");
        })()
      : await readFile(path.resolve(file), "utf8");
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`invalid event JSON: ${file}`);
  }
};

const runWorkflow = async (id: string, eventFile?: string): Promise<void> => {
  const registry = await loadRegistry(process.cwd());
  const selected = registry.filter(({ def }) => def.id === id);
  if (selected.length !== 1) throw new Error(`unknown workflow: ${id}`);

  const event = await readEvent(eventFile);
  const controller = new AbortController();
  let cancelledWith: 130 | 143 | undefined;
  const interrupt = (): void => {
    cancelledWith ??= 130;
    controller.abort();
  };
  const terminate = (): void => {
    cancelledWith ??= 143;
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    await runLocal(selected[0]!.def, {
      cwd: process.cwd(),
      event,
      signal: controller.signal,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    if (cancelledWith) process.exitCode = cancelledWith;
  } catch (error) {
    if (!cancelledWith) throw error;
    process.exitCode = cancelledWith;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
};

const run = defineCommand({
  meta: { name: "run", description: "Run a workflow locally" },
  args: {
    workflow: { type: "positional", required: true, description: "Workflow id" },
    event: { type: "string", description: "Normalized event JSON file, or - for stdin" },
  },
  async run({ args }) {
    try {
      if (args._.length !== 1) throw new Error("usage: runway run <workflow> [--event <file|->]");
      await runWorkflow(args.workflow, args.event);
    } catch (err) {
      console.error("runway: run failed");
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  },
});

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

const connectGitHubCommand = defineCommand({
  meta: { name: "github", description: "Connect this repository to GitHub" },
  async run({ rawArgs }) {
    try {
      if (rawArgs.length > 0) throw new Error("usage: runway connect github");
      await assertCleanWorktree(process.cwd());
      const result = await connectGitHub(await loadRegistry(process.cwd(), { committed: true }), {
        cwd: process.cwd(),
        interactive: interactiveCloudAuth(),
      });
      console.log(`Connected ${result.name} to ${result.defaultBranch}`);
      for (const endpoint of result.urls) console.log(`${endpoint.id}: ${endpoint.url}`);
    } catch (err) {
      console.error("runway: connect failed");
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  },
});

const connect = defineCommand({
  meta: { name: "connect", description: "Connect repository automation" },
  subCommands: { github: connectGitHubCommand },
});

const internalRelease = defineCommand({
  meta: { name: "release", description: "Activate a Workers Builds release" },
  async run({ rawArgs }) {
    try {
      if (rawArgs.length > 0) throw new Error("invalid internal release arguments");
      assertWorkersBuildEnvironment(process.env);
      await assertCleanWorktree(process.cwd());
      const result = await releaseFromBuild(
        await loadRegistry(process.cwd(), { committed: true }),
        {
          cwd: process.cwd(),
        },
      );
      console.log(
        result.changed
          ? `Activated release ${result.registryVersion}`
          : `Release ${result.registryVersion} is already active`,
      );
    } catch (err) {
      console.error("runway: release failed");
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  },
});

const internal = defineCommand({
  meta: { name: "internal", description: "Runway provider operations" },
  subCommands: { release: internalRelease },
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
      connect,
      init,
      internal,
      run,
      secrets,
    },
  }),
);
