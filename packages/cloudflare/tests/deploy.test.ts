import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { cron, webhook, workflow } from "@runway/core";
import type { Registry, WorkflowDefinition } from "@runway/core";
import { expect, test } from "vitest";

import { generateWorker } from "../src/codegen.ts";
import { cloudflare } from "../src/deploy.ts";
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

  expect(() => generateWorker(shared, { cwd: "/tmp/project" })).not.toThrow();
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

  expect(() => generateWorker(conflicting, { cwd: "/tmp/project" })).toThrow(
    'src/c.ts: webhook path "/linear" conflicts with src/a.ts: ' +
      'secret ("OTHER_SECRET" vs "HOOK_SECRET"), signatureHeader ("x-other" vs "x-signature")',
  );
  expect(() => generateWorker(staleTimestamp, { cwd: "/tmp/project" })).toThrow(
    'src/d.ts: webhook path "/linear" conflicts with src/a.ts: ' +
      'timestamp ({"field":"ts","toleranceMs":5000,"source":"body"} vs {"field":"ts","toleranceMs":60000,"source":"body"})',
  );
});

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
      env: deployEnv,
    });

    expect(generateWorker(registry, { cwd: project.cwd })).toContain(
      'from "./.runway/workflows/hello.ts"',
    );
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
  } finally {
    await project.cleanup();
  }
});

test("deploy rejects a secret that collides with a workflow binding", async () => {
  const colliding: Registry = [
    {
      path: ".runway/workflows/colliding.ts",
      exportName: "default",
      def: workflow({
        id: "hook-secret",
        secrets: ["HOOK_SECRET"],
        trigger: (tctx) =>
          webhook({
            path: "/hook-secret",
            secret: tctx.secrets.HOOK_SECRET,
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
      cloudflare({ client: () => client }).deploy(colliding, {
        cwd: project.cwd,
        env: {
          CLOUDFLARE_API_TOKEN: "token",
          CLOUDFLARE_ACCOUNT_ID: "account",
          HOOK_SECRET: "secret-value",
        },
      }),
    ).rejects.toThrow('binding "HOOK_SECRET" is used by workflow "hook-secret" and a secret');
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
      cloudflare({ client: () => client }).deploy(registry, {
        cwd: project.cwd,
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
