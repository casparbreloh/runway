import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createWorkflow, cron, webhook } from "@runway/core";
import type { Registry, WorkflowDefinition } from "@runway/core";
import { expect, test } from "vitest";

import { cloudflare } from "../src/deploy.ts";
import type { CloudflareApi } from "../src/deploy.ts";

const registry: Registry = [
  {
    path: "src/hello.ts",
    def: createWorkflow({ id: "hello", secrets: ["LINEAR_WEBHOOK_SECRET", "LINEAR_API_KEY"] })
      .trigger(
        webhook({ path: "/hello", secret: "LINEAR_WEBHOOK_SECRET", header: "linear-signature" }),
      )
      .handler(async () => {}),
  },
  {
    path: "src/daily.ts",
    def: createWorkflow({ id: "daily" })
      .trigger(cron("0 9 * * *"))
      .handler(async () => {}),
  },
];

const moduleOf = (def: WorkflowDefinition): string =>
  `import { LinearClient } from "@linear/sdk";
export default { ...${JSON.stringify({ ...def, handler: undefined })}, handler: async () => {
  void LinearClient;
  await import("@cloudflare/sandbox");
} };
`;

const writeProject = async (): Promise<{ cwd: string; cleanup(): Promise<void> }> => {
  const cwd = await mkdtemp(
    path.join(path.resolve(import.meta.dirname, "../../../example"), ".tmp-deploy-test-"),
  );
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "ship-it" }));
  for (const w of registry) {
    await writeFile(path.join(cwd, w.path), moduleOf(w.def));
  }
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};

interface ApiCalls {
  metadata?: unknown;
  schedules?: unknown;
  workflowUpdates: unknown[];
  workflowDeletes: unknown[];
  subdomains: unknown[];
  applicationsCreated: unknown[];
}

const fakeApi = (
  calls: ApiCalls,
  opts: {
    workflows?: ReadonlyArray<{ name: string; script_name: string }>;
    namespaces?: () => ReadonlyArray<{ id: string; class: string; script: string }>;
  } = {},
): CloudflareApi => ({
  workers: {
    scripts: {
      update: async (...args) => {
        calls.metadata = args[1].metadata;
      },
      schedules: {
        update: async (...args) => {
          calls.schedules = args[1].body;
        },
      },
      subdomain: {
        create: async (...args) => {
          calls.subdomains.push(args);
        },
      },
    },
    subdomains: {
      get: async () => ({ subdomain: "tester" }),
    },
  },
  workflows: {
    update: async (...args) => {
      calls.workflowUpdates.push(args);
    },
    list: async () => ({ result: opts.workflows ?? [] }),
    delete: async (...args) => {
      calls.workflowDeletes.push(args);
    },
  },
  durableObjects: {
    namespaces: {
      list: async () => ({ result: opts.namespaces?.() ?? [] }),
    },
  },
  containers: {
    applications: {
      list: async () => ({ result: [] }),
      create: async (params) => {
        calls.applicationsCreated.push(params);
        return {};
      },
      update: async () => ({}),
    },
  },
});

const emptyCalls = (): ApiCalls => ({
  workflowUpdates: [],
  workflowDeletes: [],
  subdomains: [],
  applicationsCreated: [],
});

const deployEnv = {
  CLOUDFLARE_API_TOKEN: "token",
  CLOUDFLARE_ACCOUNT_ID: "account",
  LINEAR_WEBHOOK_SECRET: "secret-value",
  LINEAR_API_KEY: "key-value",
};

test("deploy bundles, uploads bindings, owns the script, and returns webhook urls", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls, {
    workflows: [
      { name: "hello", script_name: "runway-ship-it" },
      { name: "stale-flow", script_name: "runway-ship-it" },
      { name: "other", script_name: "runway-other" },
    ],
  });

  try {
    const result = await cloudflare({ client: () => client }).deploy(registry, {
      cwd: project.cwd,
      outDir: path.join(project.cwd, ".runway"),
      env: deployEnv,
    });

    expect(result).toEqual({
      script: "runway-ship-it",
      urls: [{ id: "hello", url: "https://runway-ship-it.tester.workers.dev/hello" }],
    });
    const metadata = calls.metadata as {
      compatibility_flags?: ReadonlyArray<string>;
      bindings: ReadonlyArray<unknown>;
    };
    expect(metadata.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(metadata.bindings).toEqual([
      { type: "workflow", name: "HELLO", workflow_name: "hello", class_name: "Hello" },
      { type: "workflow", name: "DAILY", workflow_name: "daily", class_name: "Daily" },
      { type: "secret_text", name: "LINEAR_WEBHOOK_SECRET", text: "secret-value" },
      { type: "secret_text", name: "LINEAR_API_KEY", text: "key-value" },
    ]);
    expect(calls.workflowUpdates).toEqual([
      ["hello", { account_id: "account", class_name: "Hello", script_name: "runway-ship-it" }],
      ["daily", { account_id: "account", class_name: "Daily", script_name: "runway-ship-it" }],
    ]);
    expect(calls.workflowDeletes).toEqual([["stale-flow", { account_id: "account" }]]);
    expect(calls.subdomains).toEqual([
      ["runway-ship-it", { account_id: "account", enabled: true }],
    ]);
    expect(calls.schedules).toEqual([{ cron: "0 9 * * *" }]);
    const wrangler = JSON.parse(
      await readFile(path.join(project.cwd, ".runway/wrangler.jsonc"), "utf8"),
    ) as { triggers?: { crons: ReadonlyArray<string> } };
    expect(wrangler.triggers).toEqual({ crons: ["0 9 * * *"] });
  } finally {
    await project.cleanup();
  }
});

test("deploy requires declared secrets before upload", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls);

  try {
    await expect(
      cloudflare({ client: () => client }).deploy(registry, {
        cwd: project.cwd,
        outDir: path.join(project.cwd, ".runway"),
        env: {
          CLOUDFLARE_API_TOKEN: "token",
          CLOUDFLARE_ACCOUNT_ID: "account",
        },
      }),
    ).rejects.toThrow(/missing required env var\(s\): LINEAR_WEBHOOK_SECRET, LINEAR_API_KEY/);
    expect(calls.metadata).toBeUndefined();
  } finally {
    await project.cleanup();
  }
});

test("deploy with sandbox provisions the container application", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  let uploaded = false;
  const client = fakeApi(calls, {
    namespaces: () =>
      uploaded ? [{ id: "ns-1", class: "Sandbox", script: "runway-ship-it" }] : [],
  });
  const update = client.workers.scripts.update;
  client.workers.scripts.update = async (...args) => {
    uploaded = true;
    return update(...args);
  };

  try {
    await cloudflare({ client: () => client, sandbox: true }).deploy(registry, {
      cwd: project.cwd,
      outDir: path.join(project.cwd, ".runway"),
      env: deployEnv,
    });

    const metadata = calls.metadata as {
      containers?: unknown;
      migrations?: unknown;
      bindings: ReadonlyArray<unknown>;
    };
    expect(metadata.containers).toEqual([{ class_name: "Sandbox" }]);
    expect(metadata.migrations).toEqual({ new_tag: "v1", new_sqlite_classes: ["Sandbox"] });
    expect(metadata.bindings).toContainEqual({
      type: "durable_object_namespace",
      name: "Sandbox",
      class_name: "Sandbox",
    });
    expect(calls.applicationsCreated).toEqual([
      {
        account_id: "account",
        body: {
          name: "runway-ship-it-sandbox",
          scheduling_policy: "default",
          instances: 0,
          max_instances: 5,
          durable_objects: { namespace_id: "ns-1" },
          configuration: { image: "docker.io/cloudflare/sandbox:0.12.1", instance_type: "basic" },
        },
      },
    ]);
    const worker = await readFile(path.join(project.cwd, ".runway/worker.gen.ts"), "utf8");
    expect(worker).toContain('export { Sandbox } from "@cloudflare/sandbox";');
    const wrangler = JSON.parse(
      await readFile(path.join(project.cwd, ".runway/wrangler.jsonc"), "utf8"),
    ) as Record<string, unknown>;
    expect(wrangler.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(wrangler.containers).toEqual([
      {
        class_name: "Sandbox",
        image: "docker.io/cloudflare/sandbox:0.12.1",
        instance_type: "basic",
        max_instances: 5,
      },
    ]);
    expect(wrangler.durable_objects).toEqual({
      bindings: [{ class_name: "Sandbox", name: "Sandbox" }],
    });
    expect(wrangler.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["Sandbox"] }]);
  } finally {
    await project.cleanup();
  }
});
