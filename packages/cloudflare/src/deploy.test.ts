import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Registry } from "@runway/core";
import { expect, test } from "vitest";

import { cloudflare } from "./deploy.ts";
import type { CloudflareApi } from "./deploy.ts";

const writeProject = async (): Promise<{
  cwd: string;
  registry: Registry;
  cleanup(): Promise<void>;
}> => {
  const cwd = await mkdtemp(
    path.join(path.resolve(import.meta.dirname, "../../../example"), ".tmp-deploy-test-"),
  );
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "ship-it" }));
  await writeFile(
    path.join(cwd, "src/hello.ts"),
    `export default {
  __kind: "workflow",
  id: "hello",
  trigger: {
    type: "webhook",
    path: "/hello",
    auth: {
      type: "raw-hmac-sha256",
      header: "linear-signature",
      secret: "LINEAR_WEBHOOK_SECRET"
    }
  },
  handler: async () => {}
};
`,
  );
  await writeFile(
    path.join(cwd, "src/daily.ts"),
    `export default {
  __kind: "workflow",
  id: "daily",
  trigger: { type: "cron", cron: "0 9 * * *" },
  handler: async () => {}
};
`,
  );

  return {
    cwd,
    registry: [
      {
        path: "src/hello.ts",
        def: {
          __kind: "workflow",
          id: "hello",
          trigger: {
            type: "webhook",
            path: "/hello",
            auth: {
              type: "raw-hmac-sha256",
              header: "linear-signature",
              secret: "LINEAR_WEBHOOK_SECRET",
            },
          },
          handler: async () => {},
        },
      },
      {
        path: "src/daily.ts",
        def: {
          __kind: "workflow",
          id: "daily",
          trigger: { type: "cron", cron: "0 9 * * *" },
          handler: async () => {},
        },
      },
    ],
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
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
          return {} as Awaited<ReturnType<CloudflareApi["workers"]["scripts"]["update"]>>;
        },
        schedules: {
          update: async (...args) => {
            calls.schedules = args;
            return {} as Awaited<
              ReturnType<CloudflareApi["workers"]["scripts"]["schedules"]["update"]>
            >;
          },
        },
      },
    },
    workflows: {
      update: async (...args) => {
        calls.workflows.push(args);
        return {} as Awaited<ReturnType<CloudflareApi["workflows"]["update"]>>;
      },
    },
  };

  try {
    await cloudflare({ client: () => client }).deploy(project.registry, {
      cwd: project.cwd,
      outDir: path.join(project.cwd, ".runway"),
      env: {
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "account",
        LINEAR_WEBHOOK_SECRET: "secret-value",
      },
    });

    expect(calls.script?.[0]).toBe("runway-ship-it");
    expect(calls.script?.[1].metadata.bindings).toEqual([
      { type: "workflow", name: "HELLO", workflow_name: "hello", class_name: "Hello" },
      { type: "workflow", name: "DAILY", workflow_name: "daily", class_name: "Daily" },
      { type: "secret_text", name: "LINEAR_WEBHOOK_SECRET", text: "secret-value" },
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
