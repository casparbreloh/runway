import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createWorkflow, cron, hmacSha256, webhook } from "@runway/core";
import type { Registry, WorkflowDefinition } from "@runway/core";
import { expect, test } from "vitest";

import { cloudflare } from "../src/deploy.ts";
import type { CloudflareApi } from "../src/deploy.ts";

const registry: Registry = [
  {
    path: "src/hello.ts",
    exportName: "default",
    def: createWorkflow({
      id: "hello",
      trigger: webhook({
        path: "/hello",
        auth: hmacSha256({ header: "linear-signature", secret: "LINEAR_WEBHOOK_SECRET" }),
      }),
      secrets: ["LINEAR_API_KEY"],
    }).handler(async () => {}),
  },
  {
    path: "src/daily.ts",
    exportName: "daily",
    def: createWorkflow({ id: "daily", trigger: cron("0 9 * * *") }).handler(async () => {}),
  },
];

const moduleOf = (name: string, def: WorkflowDefinition): string =>
  `export ${name === "default" ? "default" : `const ${name} =`} { ...${JSON.stringify({ ...def, handler: undefined })}, handler: async () => {} };\n`;

const writeProject = async (): Promise<{ cwd: string; cleanup(): Promise<void> }> => {
  const cwd = await mkdtemp(
    path.join(path.resolve(import.meta.dirname, "../../../example"), ".tmp-deploy-test-"),
  );
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "ship-it" }));
  for (const w of registry) {
    await writeFile(path.join(cwd, w.path), moduleOf(w.exportName, w.def));
  }
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};

test("deploy uploads workflow bindings, webhook secrets, and cron schedules", async () => {
  const project = await writeProject();
  const calls: {
    script?: Parameters<CloudflareApi["workers"]["scripts"]["update"]>;
    workflows: Parameters<CloudflareApi["workflows"]["update"]>[];
    schedules?: Parameters<CloudflareApi["workers"]["scripts"]["schedules"]["update"]>;
  } = { workflows: [] };
  const client: CloudflareApi = {
    workers: {
      scripts: {
        update: async (...args) => {
          calls.script = args;
        },
        schedules: {
          update: async (...args) => {
            calls.schedules = args;
          },
        },
      },
    },
    workflows: {
      update: async (...args) => {
        calls.workflows.push(args);
      },
    },
  };

  try {
    await cloudflare({ client: () => client }).deploy(registry, {
      cwd: project.cwd,
      env: {
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "account",
        LINEAR_WEBHOOK_SECRET: "secret-value",
        LINEAR_API_KEY: "key-value",
      },
    });

    expect(calls.script?.[0]).toBe("runway-ship-it");
    expect(calls.script?.[1].metadata.bindings).toEqual([
      { type: "workflow", name: "HELLO", workflow_name: "hello", class_name: "Hello" },
      { type: "workflow", name: "DAILY", workflow_name: "daily", class_name: "Daily" },
      { type: "secret_text", name: "LINEAR_WEBHOOK_SECRET", text: "secret-value" },
      { type: "secret_text", name: "LINEAR_API_KEY", text: "key-value" },
    ]);
    expect(calls.workflows).toEqual([
      ["hello", { account_id: "account", class_name: "Hello", script_name: "runway-ship-it" }],
      ["daily", { account_id: "account", class_name: "Daily", script_name: "runway-ship-it" }],
    ]);
    expect(calls.schedules).toEqual([
      "runway-ship-it",
      { account_id: "account", body: [{ cron: "0 9 * * *" }] },
    ]);
  } finally {
    await project.cleanup();
  }
});

test("deploy requires webhook secrets and workflow secrets before upload", async () => {
  const project = await writeProject();
  let uploaded = false;
  const client: CloudflareApi = {
    workers: {
      scripts: {
        update: async () => {
          uploaded = true;
        },
        schedules: {
          update: async () => {},
        },
      },
    },
    workflows: {
      update: async () => {},
    },
  };

  try {
    await expect(
      cloudflare({ client: () => client }).deploy(registry, {
        cwd: project.cwd,
        env: {
          CLOUDFLARE_API_TOKEN: "token",
          CLOUDFLARE_ACCOUNT_ID: "account",
        },
      }),
    ).rejects.toThrow(/missing required env var\(s\): LINEAR_WEBHOOK_SECRET, LINEAR_API_KEY/);
    expect(uploaded).toBe(false);
  } finally {
    await project.cleanup();
  }
});
