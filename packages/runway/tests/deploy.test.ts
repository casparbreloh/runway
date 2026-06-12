import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { cron, webhook, workflow } from "runway";
import type { Registry, WorkflowDefinition } from "runway";
import { expect, test } from "vitest";

import { generateWorker } from "../src/codegen.ts";
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

const generateTestWorker = (
  testRegistry: Registry,
  cwd = "/tmp/project",
  modules: Record<string, string> = {},
  workflowLoaders: Record<string, string> = {},
): string => generateWorker(testRegistry, { cwd, modules, workflowLoaders });

const moduleOf = (name: string, def: WorkflowDefinition): string =>
  `import { LinearClient } from "@linear/sdk";
export ${name === "default" ? "default" : `const ${name} =`} { ...${JSON.stringify({ ...def, handler: undefined })}, handler: async () => {
  void LinearClient;
} };
`;

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

const writeWrangler = async (cwd: string): Promise<string> => {
  const bin = path.join(cwd, ".bin");
  await mkdir(bin, { recursive: true });
  const wrangler = path.join(bin, "wrangler");
  await writeFile(wrangler, "#!/bin/sh\nprintf '{\"loggedIn\":true}\\n'\n");
  await chmod(wrangler, 0o755);
  return bin;
};

interface ApiCalls {
  metadata?: unknown;
  schedules?: unknown;
  workflowUpdates: unknown[];
  workflowDeletes: unknown[];
  subdomains: unknown[];
}

const fakeApi = (
  calls: ApiCalls,
  opts: {
    workflows?: ReadonlyArray<{ name: string; script_name: string }>;
    accounts?: ReadonlyArray<{ id: string }>;
    scripts?: ReadonlyArray<{ id: string; migration_tag?: string }>;
    secrets?: ReadonlyArray<{ name: string }>;
    secretsError?: unknown;
  } = {},
): CloudflareApi => ({
  accounts: {
    list: async () => opts.accounts ?? [{ id: "account" }],
  },
  workers: {
    scripts: {
      list: async () => opts.scripts ?? [],
      update: async (...args) => {
        calls.metadata = args[1].metadata;
      },
      secrets: {
        list: async () => {
          if (opts.secretsError) throw opts.secretsError;
          return opts.secrets ?? [];
        },
        bulkUpdate: async () => {},
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
});

const emptyCalls = (): ApiCalls => ({
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

const sharedPathWorkflow = (
  id: string,
  overrides: Partial<{
    secretName: string;
    signatureHeader: string;
    prefix: string;
    toleranceMs: number;
  }> = {},
): WorkflowDefinition => {
  const secretName = overrides.secretName ?? "HOOK_SECRET";
  return workflow({
    id,
    secrets: [secretName],
    trigger: (tctx) =>
      webhook({
        path: "/linear",
        secret: tctx.secrets[secretName]!,
        signatureHeader: overrides.signatureHeader ?? "x-signature",
        prefix: overrides.prefix ?? "sha256=",
        timestamp: { field: "ts", toleranceMs: overrides.toleranceMs ?? 60_000 },
      }),
  }).handler(async () => {});
};

test("workflows sharing a webhook path with identical verification config are accepted", () => {
  const shared: Registry = [
    { path: "src/a.ts", exportName: "default", def: sharedPathWorkflow("a") },
    { path: "src/b.ts", exportName: "default", def: sharedPathWorkflow("b") },
  ];

  expect(() => generateTestWorker(shared)).not.toThrow();
});

test("workflows sharing a webhook path with conflicting verification config are rejected", () => {
  const conflicting: Registry = [
    { path: "src/a.ts", exportName: "default", def: sharedPathWorkflow("a") },
    {
      path: "src/c.ts",
      exportName: "default",
      def: sharedPathWorkflow("c", { secretName: "OTHER_SECRET", signatureHeader: "x-other" }),
    },
  ];
  const staleTimestamp: Registry = [
    { path: "src/a.ts", exportName: "default", def: sharedPathWorkflow("a") },
    {
      path: "src/d.ts",
      exportName: "default",
      def: sharedPathWorkflow("d", { toleranceMs: 5_000 }),
    },
  ];

  expect(() => generateTestWorker(conflicting)).toThrow(
    'src/c.ts: webhook path "/linear" conflicts with src/a.ts: ' +
      'secret ("OTHER_SECRET" vs "HOOK_SECRET"), signatureHeader ("x-other" vs "x-signature")',
  );
  expect(() => generateTestWorker(staleTimestamp)).toThrow(
    'src/d.ts: webhook path "/linear" conflicts with src/a.ts: ' +
      'timestamp ({"field":"ts","toleranceMs":5000,"source":"body"} vs {"field":"ts","toleranceMs":60000,"source":"body"})',
  );
});

test("deploy bundles, uploads bindings, owns the script, and returns webhook urls", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls, {
    workflows: [
      { name: "hello", script_name: "runway" },
      { name: "stale-flow", script_name: "runway" },
      { name: "other", script_name: "runway-other" },
    ],
  });

  try {
    const result = await deploy(registry, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => client,
    });

    const generated = generateTestWorker(
      registry,
      project.cwd,
      { "hello-hash": "export default {}", "daily-hash": "export default {}" },
      { hello: "hello-hash", daily: "daily-hash" },
    );

    expect(generated).toContain('from "./.runway/workflows/hello.ts"');
    expect(generated).toContain(
      'const workflowLoaders: Record<string, string> = {"hello":"hello-hash","daily":"daily-hash"}',
    );
    expect(generated).toContain('compatibilityFlags: ["nodejs_compat"]');
    expect(generated).toContain("const secretBindings");
    expect(generated).toContain("...secretsFor(parentEnv, workflowId)");
    expect(generated).toContain('export { Sandbox } from "@cloudflare/sandbox";');
    expect(generated).toContain('"Sandbox": parentEnv["Sandbox"]');
    expect(generated).toContain("wrapWorkflowBinding({ workflowId })");
    expect(generated).not.toContain("wrapWorkflowBinding({ workflowId, loaderId })");
    expect(result).toEqual({
      script: "runway",
      urls: [{ id: "hello", url: "https://runway.tester.workers.dev/hello" }],
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
        workflow_name: "runway",
        class_name: "DynamicWorkflow",
      },
      { type: "durable_object_namespace", name: "Sandbox", class_name: "Sandbox" },
      { type: "secret_text", name: "LINEAR_WEBHOOK_SECRET", text: "secret-value" },
      { type: "secret_text", name: "LINEAR_API_KEY", text: "key-value" },
    ]);
    expect(metadata.containers).toEqual([
      {
        class_name: "Sandbox",
        image: "docker.io/cloudflare/sandbox:0.12.1",
        instance_type: "lite",
      },
    ]);
    expect(metadata.migrations).toEqual({
      new_tag: "runway-sandbox-v1",
      new_sqlite_classes: ["Sandbox"],
    });
    expect(calls.workflowUpdates).toEqual([
      ["runway", { account_id: "account", class_name: "DynamicWorkflow", script_name: "runway" }],
    ]);
    expect(calls.workflowDeletes).toEqual([
      ["hello", { account_id: "account" }],
      ["stale-flow", { account_id: "account" }],
    ]);
    expect(calls.subdomains).toEqual([["runway", { account_id: "account", enabled: true }]]);
    expect(calls.schedules).toEqual([{ cron: "0 9 * * *" }]);
  } finally {
    await project.cleanup();
  }
});

test("deploy does not replay the sandbox migration after it has been applied", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls, {
    scripts: [{ id: "runway", migration_tag: "runway-sandbox-v1" }],
  });

  try {
    await deploy(registry, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => client,
    });

    const metadata = calls.metadata as { migrations?: unknown };
    expect(metadata.migrations).toBeUndefined();
  } finally {
    await project.cleanup();
  }
});

test("deploy rejects a secret that collides with a runway binding", async () => {
  const colliding: Registry = [
    {
      path: ".runway/workflows/colliding.ts",
      exportName: "default",
      def: workflow({
        id: "colliding",
        secrets: ["WORKFLOWS"],
        trigger: (tctx) =>
          webhook({
            path: "/colliding",
            secret: tctx.secrets.WORKFLOWS,
            signatureHeader: "x-signature",
          }),
      }).handler(async () => {}),
    },
  ];
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls);

  try {
    await expect(
      deploy(colliding, {
        cwd: project.cwd,
        env: {
          CLOUDFLARE_API_TOKEN: "token",
          CLOUDFLARE_ACCOUNT_ID: "account",
          WORKFLOWS: "secret-value",
        },
        client: () => client,
        wranglerAuth: false,
      }),
    ).rejects.toThrow('binding "WORKFLOWS" is used by Runway workflow binding and a secret');
    expect(calls.metadata).toBeUndefined();
  } finally {
    await project.cleanup();
  }
});

test("deploy rejects a secret that collides with the sandbox binding", async () => {
  const colliding: Registry = [
    {
      path: ".runway/workflows/colliding.ts",
      exportName: "default",
      def: workflow({
        id: "colliding",
        secrets: ["Sandbox"],
        trigger: () => cron("0 9 * * *"),
      }).handler(async () => {}),
    },
  ];
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls);

  try {
    await expect(
      deploy(colliding, {
        cwd: project.cwd,
        env: {
          CLOUDFLARE_API_TOKEN: "token",
          CLOUDFLARE_ACCOUNT_ID: "account",
          Sandbox: "secret-value",
        },
        client: () => client,
        wranglerAuth: false,
      }),
    ).rejects.toThrow('binding "Sandbox" is used by Runway sandbox binding and a secret');
    expect(calls.metadata).toBeUndefined();
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

test("deploy accepts remote scoped secrets", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls, {
    secrets: [
      { name: "RUNWAY_GLOBAL_LINEAR_WEBHOOK_SECRET" },
      { name: "RUNWAY_WORKFLOW_HELLO_LINEAR_API_KEY" },
    ],
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
      name: "RUNWAY_GLOBAL_LINEAR_WEBHOOK_SECRET",
    });
    expect(metadata.bindings).not.toContainEqual({
      type: "secret_text",
      name: "RUNWAY_WORKFLOW_HELLO_LINEAR_API_KEY",
    });
  } finally {
    await project.cleanup();
  }
});

test("deploy treats a missing script secret list as empty", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const error = new Error("script not found") as Error & { status: number };
  error.status = 404;
  const client = fakeApi(calls, { secretsError: error });

  try {
    await deploy(registry, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => client,
      wranglerAuth: false,
    });

    expect(calls.metadata).toBeDefined();
  } finally {
    await project.cleanup();
  }
});

test("deploy env secrets override remote scoped secrets", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls, {
    secrets: [
      { name: "RUNWAY_WORKFLOW_HELLO_LINEAR_WEBHOOK_SECRET" },
      { name: "RUNWAY_GLOBAL_LINEAR_API_KEY" },
    ],
  });

  try {
    await deploy(registry, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => client,
      wranglerAuth: false,
    });

    const metadata = calls.metadata as { bindings: ReadonlyArray<unknown> };
    expect(metadata.bindings).toContainEqual({
      type: "secret_text",
      name: "LINEAR_WEBHOOK_SECRET",
      text: "secret-value",
    });
    expect(metadata.bindings).toContainEqual({
      type: "secret_text",
      name: "LINEAR_API_KEY",
      text: "key-value",
    });
    expect(metadata.bindings).not.toContainEqual({
      type: "secret_text",
      name: "RUNWAY_WORKFLOW_HELLO_LINEAR_WEBHOOK_SECRET",
    });
  } finally {
    await project.cleanup();
  }
});

test("deploy can use wrangler oauth and infer a single account", async () => {
  const project = await writeProject();
  const bin = await writeWrangler(project.cwd);
  const wranglerConfig = path.join(project.cwd, ".config", ".wrangler", "config");
  await mkdir(wranglerConfig, { recursive: true });
  await writeFile(
    path.join(wranglerConfig, "default.toml"),
    `oauth_token = "oauth-token"\nexpiration_time = ${Date.now() + 60_000}\n`,
  );
  const calls = emptyCalls();
  const client = fakeApi(calls, { accounts: [{ id: "wrangler-account" }] });
  const tokens: string[] = [];

  try {
    const result = await deploy(registry, {
      cwd: project.cwd,
      env: {
        XDG_CONFIG_HOME: path.join(project.cwd, ".config"),
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
    expect(result.script).toBe("runway");
    expect(calls.workflowUpdates).toEqual([
      [
        "runway",
        { account_id: "wrangler-account", class_name: "DynamicWorkflow", script_name: "runway" },
      ],
    ]);
  } finally {
    await project.cleanup();
  }
});

test("deploy requires account id when wrangler auth sees multiple accounts", async () => {
  const project = await writeProject();
  const bin = await writeWrangler(project.cwd);
  const wranglerConfig = path.join(project.cwd, ".config", ".wrangler", "config");
  await mkdir(wranglerConfig, { recursive: true });
  await writeFile(
    path.join(wranglerConfig, "default.toml"),
    `oauth_token = "oauth-token"\nexpiration_time = ${Date.now() + 60_000}\n`,
  );
  const client = fakeApi(emptyCalls(), { accounts: [{ id: "one" }, { id: "two" }] });

  try {
    await expect(
      deploy(registry, {
        cwd: project.cwd,
        env: {
          XDG_CONFIG_HOME: path.join(project.cwd, ".config"),
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

test("deploy ignores expired wrangler oauth tokens", async () => {
  const project = await writeProject();
  const bin = await writeWrangler(project.cwd);
  const wranglerConfig = path.join(project.cwd, ".config", ".wrangler", "config");
  await mkdir(wranglerConfig, { recursive: true });
  await writeFile(
    path.join(wranglerConfig, "default.toml"),
    `oauth_token = "oauth-token"\nexpiration_time = ${Date.now() - 60_000}\n`,
  );
  const calls = emptyCalls();

  try {
    await expect(
      deploy(registry, {
        cwd: project.cwd,
        env: {
          XDG_CONFIG_HOME: path.join(project.cwd, ".config"),
          PATH: bin,
          LINEAR_WEBHOOK_SECRET: "secret-value",
          LINEAR_API_KEY: "key-value",
        },
        client: () => fakeApi(calls),
      }),
    ).rejects.toThrow(/missing required env var\(s\): CLOUDFLARE_API_TOKEN/);
    expect(calls.metadata).toBeUndefined();
  } finally {
    await project.cleanup();
  }
});
