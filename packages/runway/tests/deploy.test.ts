import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { build as esbuild } from "esbuild";
import { cron, webhook, workflow } from "runway";
import type { Registry, WorkflowDefinition } from "runway";
import { expect, test } from "vitest";

import { deploy } from "../src/deploy.ts";
import type { CloudflareApi } from "../src/deploy.ts";

const registry: Registry = [
  {
    path: ".runway/workflows/hello.ts",
    exportName: "default",
    def: workflow({
      id: "hello",
      secrets: ["LINEAR_WEBHOOK_SECRET", "LINEAR_API_KEY"],
      trigger: (tctx) =>
        webhook({
          path: "/hello",
          secret: tctx.secrets.LINEAR_WEBHOOK_SECRET,
          signatureHeader: "linear-signature",
        }),
    }).handler(async () => {}),
  },
  {
    path: ".runway/workflows/daily.ts",
    exportName: "daily",
    def: workflow({ id: "daily", trigger: () => cron("0 9 * * *") }).handler(async () => {}),
  },
];

const moduleOf = (name: string, def: WorkflowDefinition): string =>
  `export ${name === "default" ? "default" : `const ${name} =`} { ...${JSON.stringify({ ...def, handler: undefined })}, handler: async () => {} };\n`;

const writeProject = async (): Promise<{ cwd: string; cleanup(): Promise<void> }> => {
  const cwd = await mkdtemp(
    path.join(path.resolve(import.meta.dirname, "../../../example"), ".tmp-deploy-test-"),
  );
  await mkdir(path.join(cwd, ".runway", "workflows"), { recursive: true });
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "ship-it" }));
  for (const w of registry) {
    await writeFile(path.join(cwd, w.path), moduleOf(w.exportName, w.def));
  }
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};

const writeWrangler = async (
  cwd: string,
  script = '#!/bin/sh\nprintf \'{"type":"oauth","token":"oauth-token"}\\n\'\n',
): Promise<string> => {
  const bin = path.join(cwd, ".bin");
  await mkdir(bin, { recursive: true });
  const wrangler = path.join(bin, "wrangler");
  await writeFile(wrangler, script);
  await chmod(wrangler, 0o755);
  return bin;
};

interface ApiCalls {
  containerCreates: unknown[];
  containerModifies: unknown[];
  metadata?: unknown;
  workerContents?: string;
  schedules?: unknown;
  scriptUpdates: string[];
  workflowUpdates: unknown[];
  workflowDeletes: unknown[];
  subdomains: unknown[];
}

const fakeApi = (
  calls: ApiCalls,
  opts: {
    applications?: ReadonlyArray<unknown>;
    workflows?: ReadonlyArray<{ name: string; script_name: string }>;
    accounts?: ReadonlyArray<{ id: string }>;
    scripts?: ReadonlyArray<{ id: string; migration_tag?: string }>;
    secrets?: ReadonlyArray<{ name: string }>;
  } = {},
): CloudflareApi => ({
  accounts: {
    list: async () => opts.accounts ?? [{ id: "account" }],
  },
  workers: {
    scripts: {
      list: async () => opts.scripts ?? [],
      update: async (...args) => {
        calls.scriptUpdates.push(args[0]);
        calls.metadata = args[1].metadata;
        const file = args[1].files?.[0];
        if (file && "text" in file) calls.workerContents = await file.text();
      },
      secrets: {
        list: async () => {
          return opts.secrets ?? [];
        },
        bulkUpdate: async () => {},
      },
      versions: {
        list: async () => [{ id: "version" }],
        get: async () => ({
          resources: {
            bindings: [
              {
                type: "durable_object_namespace",
                name: "RunwaySandbox",
                class_name: "Sandbox",
                namespace_id: "sandbox-namespace",
              },
            ],
          },
        }),
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
  containers: {
    applications: {
      list: async () => opts.applications ?? [],
      create: async (...args) => {
        calls.containerCreates.push(args);
      },
      modify: async (...args) => {
        calls.containerModifies.push(args);
      },
    },
  },
});

const emptyCalls = (): ApiCalls => ({
  containerCreates: [],
  containerModifies: [],
  scriptUpdates: [],
  workflowUpdates: [],
  workflowDeletes: [],
  subdomains: [],
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
    const result = await deploy(registry, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => client,
    });

    expect(result).toEqual({
      script: "runway-ship-it",
      urls: [{ id: "hello", url: "https://runway-ship-it.tester.workers.dev/hello" }],
    });
    const metadata = calls.metadata as {
      compatibility_flags?: ReadonlyArray<string>;
      keep_bindings?: ReadonlyArray<string>;
      bindings: ReadonlyArray<unknown>;
      containers?: ReadonlyArray<unknown>;
      migrations?: unknown;
    };
    expect(metadata.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(metadata.keep_bindings).toEqual(["secret_text"]);
    expect(metadata.bindings).toEqual([
      { type: "worker_loader", name: "LOADER" },
      {
        type: "workflow",
        name: "WORKFLOWS",
        workflow_name: "runway-ship-it",
        class_name: "DynamicWorkflow",
      },
      { type: "durable_object_namespace", name: "RunwaySandbox", class_name: "Sandbox" },
      { type: "secret_text", name: "LINEAR_WEBHOOK_SECRET", text: "secret-value" },
      { type: "secret_text", name: "LINEAR_API_KEY", text: "key-value" },
    ]);
    expect(metadata.containers).toEqual([
      {
        class_name: "Sandbox",
        image: "docker.io/cloudflare/sandbox:0.12.3",
        instance_type: "lite",
      },
    ]);
    expect(metadata.migrations).toEqual({
      new_tag: "runway-sandbox-v1",
      new_sqlite_classes: ["Sandbox"],
    });
    const workerContents = calls.workerContents;
    if (!workerContents) throw new Error("worker bundle was not uploaded");
    const artifact = await esbuild({
      stdin: {
        contents: workerContents,
        loader: "js",
        sourcefile: "worker.js",
      },
      bundle: false,
      format: "esm",
      metafile: true,
      write: false,
    });
    const exports = Object.values(artifact.metafile!.outputs)[0]?.exports;
    expect(exports).toEqual(
      expect.arrayContaining(["DynamicWorkflow", "RunwayRunnerBinding", "Sandbox", "default"]),
    );
    expect(calls.containerCreates).toEqual([
      [
        {
          account_id: "account",
          body: {
            name: "runway-ship-it-Sandbox",
            scheduling_policy: "default",
            configuration: {
              image: "docker.io/cloudflare/sandbox:0.12.3",
              instance_type: "lite",
            },
            instances: 0,
            max_instances: 20,
            constraints: { tiers: [1, 2] },
            durable_objects: { namespace_id: "sandbox-namespace" },
            rollout_active_grace_period: 0,
          },
        },
      ],
    ]);
    expect(calls.scriptUpdates).toEqual(["runway-ship-it"]);
    expect(calls.workflowUpdates).toEqual([
      [
        "runway-ship-it",
        { account_id: "account", class_name: "DynamicWorkflow", script_name: "runway-ship-it" },
      ],
    ]);
    expect(calls.workflowDeletes).toEqual([
      ["hello", { account_id: "account" }],
      ["stale-flow", { account_id: "account" }],
    ]);
    expect(calls.subdomains).toEqual([
      ["runway-ship-it", { account_id: "account", enabled: true }],
    ]);
    expect(calls.schedules).toEqual([{ cron: "0 9 * * *" }]);
  } finally {
    await project.cleanup();
  }
});

test("deploy accepts an explicit script name override", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls);

  try {
    const result = await deploy(registry, {
      cwd: project.cwd,
      env: { ...deployEnv, RUNWAY_SCRIPT_NAME: "custom-runway" },
      client: () => client,
    });

    expect(result).toEqual({
      script: "custom-runway",
      urls: [{ id: "hello", url: "https://custom-runway.tester.workers.dev/hello" }],
    });
    expect(calls.scriptUpdates).toEqual(["custom-runway"]);
    expect(calls.workflowUpdates).toEqual([
      [
        "custom-runway",
        { account_id: "account", class_name: "DynamicWorkflow", script_name: "custom-runway" },
      ],
    ]);
    expect(calls.subdomains).toEqual([["custom-runway", { account_id: "account", enabled: true }]]);
  } finally {
    await project.cleanup();
  }
});

test("deploy reuses the matching container application and does not replay its migration", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls, {
    scripts: [{ id: "runway-ship-it", migration_tag: "runway-sandbox-v1" }],
    applications: [
      {
        id: "application",
        name: "runway-ship-it-Sandbox",
        scheduling_policy: "default",
        configuration: {
          image: "docker.io/cloudflare/sandbox:0.12.3",
          instance_type: "lite",
        },
        instances: 0,
        max_instances: 20,
        constraints: { tiers: [1, 2] },
        durable_objects: { namespace_id: "sandbox-namespace" },
        rollout_active_grace_period: 0,
      },
    ],
  });

  try {
    await deploy(registry, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => client,
    });

    expect((calls.metadata as { migrations?: unknown }).migrations).toBeUndefined();
    expect(calls.containerCreates).toEqual([]);
    expect(calls.containerModifies).toEqual([]);
  } finally {
    await project.cleanup();
  }
});

test("deploy reconciles stale container application configuration", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls, {
    applications: [
      {
        id: "application",
        name: "runway-ship-it-Sandbox",
        configuration: { image: "old-image", instance_type: "lite" },
        durable_objects: { namespace_id: "sandbox-namespace" },
      },
    ],
  });

  try {
    await deploy(registry, { cwd: project.cwd, env: deployEnv, client: () => client });

    expect(calls.containerModifies).toEqual([
      [
        "application",
        {
          account_id: "account",
          body: {
            scheduling_policy: "default",
            configuration: {
              image: "docker.io/cloudflare/sandbox:0.12.3",
              instance_type: "lite",
            },
            instances: 0,
            max_instances: 20,
            constraints: { tiers: [1, 2] },
            rollout_active_grace_period: 0,
          },
        },
      ],
    ]);
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
      deploy(registry, {
        cwd: project.cwd,
        env: {
          CLOUDFLARE_API_TOKEN: "token",
          CLOUDFLARE_ACCOUNT_ID: "account",
        },
        client: () => client,
        wranglerAuth: false,
      }),
    ).rejects.toThrow(/missing secret\(s\): hello.LINEAR_WEBHOOK_SECRET, hello.LINEAR_API_KEY/);
    expect(calls.metadata).toBeUndefined();
  } finally {
    await project.cleanup();
  }
});

test("deploy accepts existing Worker secrets by plain name", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls, {
    secrets: [{ name: "LINEAR_WEBHOOK_SECRET" }, { name: "LINEAR_API_KEY" }],
  });

  try {
    await deploy(registry, {
      cwd: project.cwd,
      env: {
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "account",
      },
      client: () => client,
      wranglerAuth: false,
    });

    const metadata = calls.metadata as {
      keep_bindings?: ReadonlyArray<string>;
      bindings: ReadonlyArray<unknown>;
    };
    expect(metadata.keep_bindings).toEqual(["secret_text"]);
    expect(metadata.bindings).not.toContainEqual({
      type: "secret_text",
      name: "LINEAR_WEBHOOK_SECRET",
    });
    expect(metadata.bindings).not.toContainEqual({
      type: "secret_text",
      name: "LINEAR_API_KEY",
    });
  } finally {
    await project.cleanup();
  }
});

test("deploy can use wrangler oauth and infer a single account", async () => {
  const project = await writeProject();
  const bin = await writeWrangler(project.cwd);
  const calls = emptyCalls();
  const client = fakeApi(calls, { accounts: [{ id: "wrangler-account" }] });
  const tokens: string[] = [];

  try {
    const result = await deploy(registry, {
      cwd: project.cwd,
      env: {
        PATH: bin,
        LINEAR_WEBHOOK_SECRET: "secret-value",
        LINEAR_API_KEY: "key-value",
      },
      client: ({ apiToken }) => {
        tokens.push(apiToken);
        return client;
      },
    });

    expect(tokens).toEqual(["oauth-token"]);
    expect(result.script).toBe("runway-ship-it");
    expect(calls.workflowUpdates).toEqual([
      [
        "runway-ship-it",
        {
          account_id: "wrangler-account",
          class_name: "DynamicWorkflow",
          script_name: "runway-ship-it",
        },
      ],
    ]);
  } finally {
    await project.cleanup();
  }
});

test("deploy requires account id when wrangler auth sees multiple accounts", async () => {
  const project = await writeProject();
  const bin = await writeWrangler(project.cwd);
  const client = fakeApi(emptyCalls(), { accounts: [{ id: "one" }, { id: "two" }] });

  try {
    await expect(
      deploy(registry, {
        cwd: project.cwd,
        env: {
          PATH: bin,
          LINEAR_WEBHOOK_SECRET: "secret-value",
          LINEAR_API_KEY: "key-value",
        },
        client: () => client,
      }),
    ).rejects.toThrow("multiple Cloudflare accounts found; set CLOUDFLARE_ACCOUNT_ID");
  } finally {
    await project.cleanup();
  }
});
