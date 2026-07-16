import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { cron, github, webhook, workflow } from "runway";
import type { ProgressEvent, Registry, WorkflowDefinition } from "runway";
import { expect, test } from "vitest";

import { deploy, deployWithAdapters } from "../src/deploy.ts";
import type { CloudflareApi } from "../src/deploy.ts";
import { assertRepositorySourceReachable } from "../src/repository-source.ts";
import type { RepositorySource } from "../src/repository-source.ts";
import { authenticatedRepositoryFixture, repositoryFixture } from "./repository-fixture.ts";

const execFileAsync = promisify(execFile);

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

const githubRegistry: Registry = [
  {
    path: ".runway/workflows/check.ts",
    exportName: "default",
    def: workflow({
      id: "check",
      trigger: () => github({ checkName: "Check", events: [{ type: "push", branches: ["main"] }] }),
    }).handler(async () => {}),
  },
];

const moduleOf = (name: string, def: WorkflowDefinition): string =>
  `export ${name === "default" ? "default" : `const ${name} =`} { ...${JSON.stringify({ ...def, handler: undefined })}, handler: async () => {} };\n`;

const writeProject = async (): Promise<{ cwd: string; cleanup(): Promise<void> }> => {
  const cwd = await mkdtemp(
    path.join(path.resolve(import.meta.dirname, ".."), ".tmp-deploy-test-"),
  );
  await mkdir(path.join(cwd, ".runway", "workflows"), { recursive: true });
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "ship-it" }));
  for (const w of [...registry, ...githubRegistry]) {
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
  bucketCreates: unknown[];
  bucketGets: unknown[];
  artifactUploads: Array<{ bucket: string; key: string; contents: Uint8Array }>;
  containerCreates: unknown[];
  containerModifies: unknown[];
  containerRolloutCreates: unknown[];
  containerRolloutGets: unknown[];
  metadata?: unknown;
  schedules?: unknown;
  scriptUpdates: string[];
  workflowUpdates: unknown[];
  workflowDeletes: unknown[];
  subdomains: unknown[];
  operations: string[];
}

const fakeApi = (
  calls: ApiCalls,
  opts: {
    applications?: ReadonlyArray<unknown>;
    workflows?: ReadonlyArray<{ name: string; script_name: string }>;
    workflowResponse?: unknown;
    accounts?: ReadonlyArray<{ id: string }>;
    scripts?: ReadonlyArray<{ id: string; migration_tag?: string }>;
    secrets?: ReadonlyArray<{ name: string }>;
    bucketExists?: boolean;
    bucketError?: unknown;
    rolloutCreateError?: unknown;
    rolloutStatus?: string;
  } = {},
): CloudflareApi => ({
  accounts: {
    list: async () => opts.accounts ?? [{ id: "account" }],
  },
  workers: {
    scripts: {
      list: async () => opts.scripts ?? [],
      update: async (...args) => {
        calls.operations.push("worker-upload");
        calls.scriptUpdates.push(args[0]);
        calls.metadata = args[1].metadata;
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
    list: async () => opts.workflowResponse ?? { result: opts.workflows ?? [] },
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
    rollouts: {
      create: async (...args) => {
        calls.containerRolloutCreates.push(args);
        if (opts.rolloutCreateError) throw opts.rolloutCreateError;
        return { id: "rollout" };
      },
      get: async (...args) => {
        calls.containerRolloutGets.push(args);
        return { status: opts.rolloutStatus ?? "completed" };
      },
    },
  },
  r2: {
    buckets: {
      get: async (...args) => {
        calls.bucketGets.push(args);
        if (opts.bucketError) throw opts.bucketError;
        if (opts.bucketExists === false) {
          throw Object.assign(new Error("not found"), { status: 404 });
        }
        return { name: args[0] };
      },
      create: async (...args) => {
        calls.bucketCreates.push(args);
      },
      objects: {
        upload: async (bucket, key, body) => {
          calls.operations.push(`artifact-upload:${key}`);
          calls.artifactUploads.push({ bucket, key, contents: new Uint8Array(body) });
        },
      },
    },
  },
});

const emptyCalls = (): ApiCalls => ({
  bucketCreates: [],
  bucketGets: [],
  artifactUploads: [],
  containerCreates: [],
  containerModifies: [],
  containerRolloutCreates: [],
  containerRolloutGets: [],
  scriptUpdates: [],
  workflowUpdates: [],
  workflowDeletes: [],
  subdomains: [],
  operations: [],
});

const deployEnv = {
  CLOUDFLARE_API_TOKEN: "token",
  CLOUDFLARE_ACCOUNT_ID: "account",
  LINEAR_WEBHOOK_SECRET: "secret-value",
  LINEAR_API_KEY: "key-value",
};

const githubDeployEnv = {
  ...deployEnv,
  RUNWAY_GITHUB_APP_ID: "12345",
  RUNWAY_GITHUB_PRIVATE_KEY: "private-key",
  RUNWAY_GITHUB_WEBHOOK_SECRET: "webhook-secret",
};

const githubProvider = {
  resolveRepository: async () => ({
    installationId: 42,
    repository: { id: 101, name: "runway", fullName: "casparbreloh/runway" },
  }),
  createInstallationToken: async () => ({ token: "ephemeral", expiresAt: "2026-07-16T12:30:00Z" }),
};

const deployReady = async (
  calls: ApiCalls,
  opts: Parameters<typeof deploy>[1] & {
    readonly client: (opts: { apiToken: string }) => CloudflareApi;
  },
): ReturnType<typeof deploy> => {
  const { client, ...context } = opts;
  return await deployWithAdapters(registry, context, {
    client,
    repository: repositoryFixture,
    reachable: async () => {},
    ready: async ({ deploymentId }) => {
      expect(calls.metadata).toBeDefined();
      expect(deploymentId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    },
  });
};

test("deploy resolves and uploads one repo-scoped GitHub capability with one ingress URL", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  let reachableRepository: RepositorySource | undefined;

  try {
    const result = await deployWithAdapters(
      githubRegistry,
      { cwd: project.cwd, env: githubDeployEnv },
      {
        client: () => fakeApi(calls),
        repository: repositoryFixture,
        github: githubProvider,
        reachable: async (repository) => {
          reachableRepository = repository;
        },
        ready: async () => {},
      },
    );

    const resolvedRepository: RepositorySource = {
      remote: "https://github.com/casparbreloh/runway",
      commit: repositoryFixture.commit,
      authentication: authenticatedRepositoryFixture.authentication,
    };
    expect(reachableRepository).toEqual(resolvedRepository);
    expect(result.urls).toEqual([
      { id: "github", url: "https://runway-ship-it.tester.workers.dev/.runway/github" },
    ]);
    const metadata = calls.metadata as {
      bindings: ReadonlyArray<unknown>;
      migrations?: unknown;
    };
    expect(metadata.bindings).toContainEqual({
      type: "durable_object_namespace",
      name: "RUNWAY_GITHUB_COORDINATOR",
      class_name: "RunwayGitHubCoordinator",
    });
    expect(metadata.bindings).toEqual(
      expect.arrayContaining([
        { type: "secret_text", name: "RUNWAY_GITHUB_APP_ID", text: "12345" },
        { type: "secret_text", name: "RUNWAY_GITHUB_PRIVATE_KEY", text: "private-key" },
        {
          type: "secret_text",
          name: "RUNWAY_GITHUB_WEBHOOK_SECRET",
          text: "webhook-secret",
        },
      ]),
    );
    expect(metadata.migrations).toEqual({
      new_tag: "runway-github-coordinator-v2",
      new_sqlite_classes: ["Sandbox", "RunwayGitHubCoordinator"],
    });
    const artifact = JSON.parse(
      new TextDecoder().decode(calls.artifactUploads[0]!.contents),
    ) as Record<string, unknown>;
    expect(artifact.repository).toEqual(resolvedRepository);
    expect(JSON.stringify(artifact)).not.toMatch(/private-key|webhook-secret|ephemeral/);
  } finally {
    await project.cleanup();
  }
});

test("GitHub deploy fails before upload when its local App config is incomplete", async () => {
  const project = await writeProject();
  const calls = emptyCalls();

  try {
    await expect(
      deployWithAdapters(
        githubRegistry,
        {
          cwd: project.cwd,
          env: { ...deployEnv, RUNWAY_GITHUB_WEBHOOK_SECRET: "webhook-secret" },
        },
        {
          client: () => fakeApi(calls),
          repository: repositoryFixture,
          github: githubProvider,
          reachable: async () => {},
          ready: async () => {},
        },
      ),
    ).rejects.toThrow(
      "missing GitHub App deploy config: RUNWAY_GITHUB_APP_ID, RUNWAY_GITHUB_PRIVATE_KEY",
    );
    expect(calls.artifactUploads).toEqual([]);
    expect(calls.scriptUpdates).toEqual([]);
  } finally {
    await project.cleanup();
  }
});

test("GitHub deploy requires a local or preserved webhook secret before upload", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  try {
    await expect(
      deployWithAdapters(
        githubRegistry,
        {
          cwd: project.cwd,
          env: {
            ...deployEnv,
            RUNWAY_GITHUB_APP_ID: "12345",
            RUNWAY_GITHUB_PRIVATE_KEY: "private-key",
          },
        },
        {
          client: () => fakeApi(calls),
          repository: repositoryFixture,
          github: githubProvider,
          reachable: async () => {},
          ready: async () => {},
        },
      ),
    ).rejects.toThrow("missing GitHub App secret: RUNWAY_GITHUB_WEBHOOK_SECRET");
    expect(calls.artifactUploads).toEqual([]);
    expect(calls.scriptUpdates).toEqual([]);
  } finally {
    await project.cleanup();
  }
});

test("GitHub deploy preserves an existing remote webhook secret without replacing it", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  try {
    await deployWithAdapters(
      githubRegistry,
      {
        cwd: project.cwd,
        env: {
          ...deployEnv,
          RUNWAY_GITHUB_APP_ID: "12345",
          RUNWAY_GITHUB_PRIVATE_KEY: "private-key",
        },
      },
      {
        client: () =>
          fakeApi(calls, {
            secrets: [{ name: "RUNWAY_GITHUB_WEBHOOK_SECRET" }],
          }),
        repository: repositoryFixture,
        github: githubProvider,
        reachable: async () => {},
        ready: async () => {},
      },
    );

    const metadata = calls.metadata as {
      keep_bindings?: ReadonlyArray<string>;
      bindings: ReadonlyArray<unknown>;
    };
    expect(metadata.keep_bindings).toEqual(["secret_text"]);
    expect(metadata.bindings).not.toContainEqual(
      expect.objectContaining({ name: "RUNWAY_GITHUB_WEBHOOK_SECRET" }),
    );
  } finally {
    await project.cleanup();
  }
});

test("deploy rejects authored secrets that collide with reserved GitHub bindings", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const collidingRegistry: Registry = [
    {
      ...registry[1]!,
      def: workflow({
        id: "collision",
        secrets: ["RUNWAY_GITHUB_APP_ID"],
        trigger: () => cron("0 9 * * *"),
      }).handler(async () => {}),
    },
  ];
  try {
    await expect(
      deployWithAdapters(
        collidingRegistry,
        { cwd: project.cwd, env: githubDeployEnv },
        {
          client: () => fakeApi(calls),
          repository: repositoryFixture,
          github: githubProvider,
          reachable: async () => {},
          ready: async () => {},
        },
      ),
    ).rejects.toThrow(
      'binding "RUNWAY_GITHUB_APP_ID" is used by Runway GitHub App binding and a secret',
    );
    expect(calls.artifactUploads).toEqual([]);
    expect(calls.scriptUpdates).toEqual([]);
  } finally {
    await project.cleanup();
  }
});

test("GitHub credentials do not force a non-GitHub public repository into App auth", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const repository: RepositorySource = {
    remote: "https://gitlab.example/acme/runway.git",
    commit: repositoryFixture.commit,
    authentication: { type: "public" },
  };
  let resolutions = 0;
  try {
    await deployWithAdapters(
      registry,
      { cwd: project.cwd, env: githubDeployEnv },
      {
        client: () => fakeApi(calls),
        repository,
        github: {
          ...githubProvider,
          resolveRepository: async () => {
            resolutions += 1;
            return await githubProvider.resolveRepository();
          },
        },
        reachable: async (source) => expect(source).toEqual(repository),
        ready: async () => {},
      },
    );
    expect(resolutions).toBe(0);
  } finally {
    await project.cleanup();
  }
});

test.each([
  [
    undefined,
    {
      new_tag: "runway-github-coordinator-v2",
      new_sqlite_classes: ["Sandbox", "RunwayGitHubCoordinator"],
    },
  ],
  [
    "runway-sandbox-v1",
    {
      old_tag: "runway-sandbox-v1",
      new_tag: "runway-github-coordinator-v2",
      new_sqlite_classes: ["RunwayGitHubCoordinator"],
    },
  ],
  ["runway-github-coordinator-v2", undefined],
] as const)("deploy emits the exact %s migration state", async (migrationTag, expected) => {
  const project = await writeProject();
  const calls = emptyCalls();
  try {
    await deployReady(calls, {
      cwd: project.cwd,
      env: deployEnv,
      client: () =>
        fakeApi(calls, {
          scripts: migrationTag ? [{ id: "runway-ship-it", migration_tag: migrationTag }] : [],
        }),
    });
    expect((calls.metadata as { migrations?: unknown }).migrations).toEqual(expected);
  } finally {
    await project.cleanup();
  }
});

test("deploy rejects an unknown existing migration tag before upload", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  try {
    await expect(
      deployReady(calls, {
        cwd: project.cwd,
        env: deployEnv,
        client: () =>
          fakeApi(calls, {
            scripts: [{ id: "runway-ship-it", migration_tag: "unexpected-tag" }],
          }),
      }),
    ).rejects.toThrow("unsupported Runway Worker migration tag: unexpected-tag");
    expect(calls.artifactUploads).toEqual([]);
    expect(calls.scriptUpdates).toEqual([]);
  } finally {
    await project.cleanup();
  }
});

test("deploy stores immutable workflow artifacts before uploading the host Worker", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls, { bucketExists: false });

  try {
    await deployReady(calls, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => client,
    });

    expect(calls.bucketGets).toEqual([["runway-account", { account_id: "account" }]]);
    expect(calls.bucketCreates).toEqual([[{ account_id: "account", name: "runway-account" }]]);
    expect(calls.artifactUploads).toHaveLength(2);
    for (const upload of calls.artifactUploads) {
      const version = createHash("sha256").update(upload.contents).digest("hex");
      expect(upload).toMatchObject({
        bucket: "runway-account",
        key: `artifacts/${version}.json`,
      });
      expect(version).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(calls.operations.slice(-3)).toEqual([
      expect.stringMatching(/^artifact-upload:artifacts\/[a-f0-9]{64}\.json$/),
      expect.stringMatching(/^artifact-upload:artifacts\/[a-f0-9]{64}\.json$/),
      "worker-upload",
    ]);
    expect(
      calls.artifactUploads.map(({ contents }) => {
        const { source, ...artifact } = JSON.parse(new TextDecoder().decode(contents)) as Record<
          string,
          unknown
        >;
        return { ...artifact, source: typeof source };
      }),
    ).toEqual([
      {
        scriptName: "runway-ship-it",
        workflowId: "hello",
        secrets: ["LINEAR_WEBHOOK_SECRET", "LINEAR_API_KEY"],
        repository: repositoryFixture,
        source: "string",
      },
      {
        scriptName: "runway-ship-it",
        workflowId: "daily",
        secrets: [],
        repository: repositoryFixture,
        source: "string",
      },
    ]);
  } finally {
    await project.cleanup();
  }
});

test("deploy pins the current public GitHub repository commit", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls);
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: project.cwd,
    encoding: "utf8",
  });

  try {
    await deployWithAdapters(
      registry,
      { cwd: project.cwd, env: deployEnv },
      { client: () => client, reachable: async () => {}, ready: async () => {} },
    );

    const artifact = JSON.parse(
      new TextDecoder().decode(calls.artifactUploads[0]!.contents),
    ) as Record<string, unknown>;
    expect(artifact.repository).toEqual({
      remote: expect.stringMatching(/^https:\/\/github\.com\/casparbreloh\/runway(?:\.git)?$/),
      commit: stdout.trim(),
      authentication: { type: "public" },
    });
  } finally {
    await project.cleanup();
  }
});

test("private repository reachability uses one ephemeral token through exact-prompt askpass", async () => {
  const token = "private-deploy-installation-token";
  let tokenMints = 0;
  let askpass: string | undefined;
  let fetches = 0;

  await assertRepositorySourceReachable(authenticatedRepositoryFixture, {
    installationToken: async ({ authentication, purpose }) => {
      expect(authentication).toEqual(authenticatedRepositoryFixture.authentication);
      expect(purpose).toBe("checkout");
      tokenMints += 1;
      return token;
    },
    exec: async (file, args, options) => {
      expect(file).toBe("git");
      expect(args.join(" ")).not.toContain(token);
      if (!args.includes("fetch")) return { stdout: "" };
      fetches += 1;
      expect(args).toContain("http.followRedirects=false");
      expect(args).toContain("https://github.com/casparbreloh/runway");
      expect(options.env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(options.env?.RUNWAY_GITHUB_TOKEN).toBe(token);
      askpass = options.env?.GIT_ASKPASS;
      expect(askpass).toBeTruthy();
      const helper = await readFile(askpass!, "utf8");
      expect(helper).not.toContain(token);
      await expect(
        execFileAsync(askpass!, ["Username for 'https://github.com': "], {
          encoding: "utf8",
          env: options.env,
        }),
      ).resolves.toMatchObject({ stdout: "x-access-token\n" });
      await expect(
        execFileAsync(askpass!, ["Password for 'https://x-access-token@github.com': "], {
          encoding: "utf8",
          env: options.env,
        }),
      ).resolves.toMatchObject({ stdout: `${token}\n` });
      await expect(
        execFileAsync(askpass!, ["Password for 'https://example.com': "], {
          encoding: "utf8",
          env: options.env,
        }),
      ).rejects.toBeDefined();
      return { stdout: "" };
    },
  });

  expect(tokenMints).toBe(1);
  expect(fetches).toBe(1);
  await expect(access(askpass!)).rejects.toBeDefined();
});

test("public repository reachability never requests an installation token", async () => {
  let calls = 0;
  await assertRepositorySourceReachable(repositoryFixture, {
    installationToken: async () => {
      throw new Error("public source requested a token");
    },
    exec: async (_file, args, options) => {
      calls += 1;
      expect(args.join(" ")).not.toContain("token");
      expect(options.env?.RUNWAY_GITHUB_TOKEN).toBeUndefined();
      expect(options.env?.GIT_ASKPASS).toBeUndefined();
      return { stdout: "" };
    },
  });
  expect(calls).toBe(2);
});

test("authenticated repository identity cannot disagree with its derived remote", async () => {
  let tokenMints = 0;
  await expect(
    assertRepositorySourceReachable(
      { ...authenticatedRepositoryFixture, remote: "https://github.com/another/runway" },
      {
        installationToken: async () => {
          tokenMints += 1;
          return "unused";
        },
        exec: async () => ({ stdout: "" }),
      },
    ),
  ).rejects.toThrow("invalid repository source");
  expect(tokenMints).toBe(0);
});

test("deploy artifacts retain only stable GitHub installation repository identity", async () => {
  const project = await writeProject();
  const calls = emptyCalls();

  try {
    await deployWithAdapters(
      registry,
      { cwd: project.cwd, env: githubDeployEnv },
      {
        client: () => fakeApi(calls),
        repository: authenticatedRepositoryFixture,
        github: githubProvider,
        reachable: async () => {},
        ready: async () => {},
      },
    );
    const artifact = JSON.parse(
      new TextDecoder().decode(calls.artifactUploads[0]!.contents),
    ) as Record<string, unknown>;
    expect(artifact.repository).toEqual(authenticatedRepositoryFixture);
    expect(JSON.stringify(artifact)).not.toContain("token");
    expect((calls.metadata as { bindings: ReadonlyArray<unknown> }).bindings).toEqual(
      expect.arrayContaining([
        { type: "secret_text", name: "RUNWAY_GITHUB_APP_ID", text: "12345" },
        { type: "secret_text", name: "RUNWAY_GITHUB_PRIVATE_KEY", text: "private-key" },
      ]),
    );
  } finally {
    await project.cleanup();
  }
});

test("deploy rejects a commit that the repository remote cannot reconstruct", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls);

  try {
    await expect(
      deployWithAdapters(
        registry,
        { cwd: project.cwd, env: deployEnv },
        {
          client: () => client,
          repository: repositoryFixture,
          reachable: async () => {
            throw new Error(
              `repository remote does not contain commit ${repositoryFixture.commit}`,
            );
          },
          ready: async () => {},
        },
      ),
    ).rejects.toThrow(`repository remote does not contain commit ${repositoryFixture.commit}`);
    expect(calls.artifactUploads).toEqual([]);
    expect(calls.scriptUpdates).toEqual([]);
  } finally {
    await project.cleanup();
  }
});

test("deploy keeps artifact versions stable until workflow code changes", async () => {
  const project = await writeProject();
  const first = emptyCalls();
  const unchanged = emptyCalls();
  const changed = emptyCalls();

  try {
    await deployReady(first, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => fakeApi(first),
    });
    await deployReady(unchanged, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => fakeApi(unchanged),
    });

    expect(
      unchanged.artifactUploads
        .filter(({ key }) => key.startsWith("artifacts/"))
        .map(({ key }) => key),
    ).toEqual(
      first.artifactUploads.filter(({ key }) => key.startsWith("artifacts/")).map(({ key }) => key),
    );

    const hello = registry[0]!;
    await writeFile(
      path.join(project.cwd, hello.path),
      moduleOf(hello.exportName, hello.def).replace(
        "handler: async () => {}",
        'handler: async () => { return "changed"; }',
      ),
    );
    await deployReady(changed, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => fakeApi(changed),
    });

    const firstArtifacts = first.artifactUploads.filter(({ key }) => key.startsWith("artifacts/"));
    const changedArtifacts = changed.artifactUploads.filter(({ key }) =>
      key.startsWith("artifacts/"),
    );
    expect(changedArtifacts[0]?.key).not.toBe(firstArtifacts[0]?.key);
    expect(changedArtifacts[1]?.key).toBe(firstArtifacts[1]?.key);
  } finally {
    await project.cleanup();
  }
});

test("deploy reuses an existing account artifact bucket", async () => {
  const project = await writeProject();
  const calls = emptyCalls();

  try {
    await deployReady(calls, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => fakeApi(calls, { bucketExists: true }),
    });

    expect(calls.bucketGets).toEqual([["runway-account", { account_id: "account" }]]);
    expect(calls.bucketCreates).toEqual([]);
    expect(calls.artifactUploads).toHaveLength(2);
  } finally {
    await project.cleanup();
  }
});

test("deploy explains the R2 permission required to persist workflow artifacts", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const permissionError = Object.assign(new Error("forbidden"), { status: 403 });

  try {
    await expect(
      deployReady(calls, {
        cwd: project.cwd,
        env: deployEnv,
        client: () => fakeApi(calls, { bucketError: permissionError }),
      }),
    ).rejects.toThrow(
      "Cloudflare API token needs Workers R2 Storage Write permission to persist Runway workflow artifacts",
    );
    expect(calls.scriptUpdates).toEqual([]);
  } finally {
    await project.cleanup();
  }
});

test("deploy emits final progress and returns webhook urls only after readiness", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const progress: ProgressEvent[] = [];
  let observations = 0;

  try {
    const result = await deployWithAdapters(
      registry,
      {
        cwd: project.cwd,
        env: deployEnv,
        onProgress: (event) => {
          progress.push(event);
        },
      },
      {
        client: () => fakeApi(calls),
        repository: repositoryFixture,
        reachable: async () => {},
        ready: async () => {
          observations += 1;
          expect(progress.filter((event) => event.step === "deploy")).toEqual([
            { step: "deploy", status: "start" },
          ]);
        },
      },
    );

    expect(observations).toBe(1);
    expect(progress.filter((event) => event.step === "deploy")).toEqual([
      { step: "deploy", status: "start" },
      { step: "deploy", status: "done" },
    ]);
    expect(result.urls).toEqual([
      { id: "hello", url: "https://runway-ship-it.tester.workers.dev/hello" },
    ]);
  } finally {
    await project.cleanup();
  }
});

test("deploy refuses to take over a Dynamic Workflow owned by another Worker", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls, {
    workflowResponse: {
      result: [{ name: "unrelated", script_name: "unrelated-worker" }],
      async *[Symbol.asyncIterator]() {
        yield { name: "unrelated", script_name: "unrelated-worker" };
        yield { name: "runway-ship-it", script_name: "another-worker" };
      },
    },
  });

  try {
    await expect(
      deployReady(calls, {
        cwd: project.cwd,
        env: deployEnv,
        client: () => client,
      }),
    ).rejects.toThrow("Dynamic Workflow runway-ship-it already belongs to Worker another-worker");
    expect(calls.artifactUploads).toEqual([]);
    expect(calls.scriptUpdates).toEqual([]);
    expect(calls.workflowUpdates).toEqual([]);
  } finally {
    await project.cleanup();
  }
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
    const result = await deployReady(calls, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => client,
    });

    expect(result).toEqual({
      script: "runway-ship-it",
      artifactVersions: [
        expect.stringMatching(/^[a-f0-9]{64}$/),
        expect.stringMatching(/^[a-f0-9]{64}$/),
      ],
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
      { type: "r2_bucket", name: "RUNWAY_ARTIFACTS", bucket_name: "runway-account" },
      {
        type: "workflow",
        name: "WORKFLOWS",
        workflow_name: "runway-ship-it",
        class_name: "DynamicWorkflow",
      },
      { type: "durable_object_namespace", name: "RunwaySandbox", class_name: "Sandbox" },
      {
        type: "durable_object_namespace",
        name: "RUNWAY_GITHUB_COORDINATOR",
        class_name: "RunwayGitHubCoordinator",
      },
      { type: "secret_text", name: "LINEAR_WEBHOOK_SECRET", text: "secret-value" },
      { type: "secret_text", name: "LINEAR_API_KEY", text: "key-value" },
      {
        type: "secret_text",
        name: "RUNWAY_SECRET_SNAPSHOT_KEY",
        text: expect.any(String),
      },
      {
        type: "secret_text",
        name: expect.stringMatching(/^RUNWAY_SECRET_SNAPSHOT_KEY_[a-f0-9]{32}$/),
        text: expect.any(String),
      },
    ]);
    const snapshotKeys = metadata.bindings.filter(
      (binding): binding is { name: string; text: string } =>
        !!binding &&
        typeof binding === "object" &&
        "name" in binding &&
        typeof binding.name === "string" &&
        binding.name.startsWith("RUNWAY_SECRET_SNAPSHOT_KEY") &&
        "text" in binding &&
        typeof binding.text === "string",
    );
    expect(JSON.parse(snapshotKeys[0]!.text)).toEqual({ identity: snapshotKeys[1]!.name });
    expect(JSON.parse(snapshotKeys[1]!.text)).toEqual({
      identity: snapshotKeys[1]!.name,
      key: expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/),
    });
    expect(metadata.containers).toEqual([
      {
        class_name: "Sandbox",
        image: "docker.io/cloudflare/sandbox:0.12.3",
        instance_type: "basic",
      },
    ]);
    expect(metadata.migrations).toEqual({
      new_tag: "runway-github-coordinator-v2",
      new_sqlite_classes: ["Sandbox", "RunwayGitHubCoordinator"],
    });
    expect(calls.containerCreates).toEqual([
      [
        {
          account_id: "account",
          body: {
            name: "runway-ship-it-Sandbox",
            scheduling_policy: "default",
            configuration: {
              image: "docker.io/cloudflare/sandbox:0.12.3",
              instance_type: "basic",
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
    const result = await deployReady(calls, {
      cwd: project.cwd,
      env: { ...deployEnv, RUNWAY_SCRIPT_NAME: "custom-runway" },
      client: () => client,
    });

    expect(result).toEqual({
      script: "custom-runway",
      artifactVersions: [
        expect.stringMatching(/^[a-f0-9]{64}$/),
        expect.stringMatching(/^[a-f0-9]{64}$/),
      ],
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

test("deploy reuses the matching container application and does not replay its v2 migration", async () => {
  const project = await writeProject();
  const calls = emptyCalls();
  const client = fakeApi(calls, {
    scripts: [{ id: "runway-ship-it", migration_tag: "runway-github-coordinator-v2" }],
    applications: [
      {
        id: "application",
        name: "runway-ship-it-Sandbox",
        scheduling_policy: "default",
        configuration: {
          image: "docker.io/cloudflare/sandbox:0.12.3",
          vcpu: 0.25,
          memory_mib: 1_024,
          disk: { size_mb: 4_000 },
        },
        instances: 7,
        max_instances: 20,
        constraints: { tiers: [1, 2] },
        durable_objects: { namespace_id: "sandbox-namespace" },
        rollout_active_grace_period: 0,
      },
    ],
  });

  try {
    await deployReady(calls, {
      cwd: project.cwd,
      env: deployEnv,
      client: () => client,
    });

    expect((calls.metadata as { migrations?: unknown }).migrations).toBeUndefined();
    expect(calls.containerCreates).toEqual([]);
    expect(calls.containerModifies).toEqual([]);
    expect(calls.containerRolloutCreates).toEqual([]);
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
    await deployReady(calls, { cwd: project.cwd, env: deployEnv, client: () => client });

    expect(calls.containerModifies).toEqual([
      [
        "application",
        {
          account_id: "account",
          body: {
            scheduling_policy: "default",
            configuration: {
              image: "docker.io/cloudflare/sandbox:0.12.3",
              instance_type: "basic",
            },
            instances: 0,
            max_instances: 20,
            constraints: { tiers: [1, 2] },
            rollout_active_grace_period: 0,
          },
        },
      ],
    ]);
    expect(calls.containerRolloutCreates).toEqual([
      [
        "application",
        {
          account_id: "account",
          body: {
            description: "Runway deployment",
            strategy: "rolling",
            target_configuration: {
              image: "docker.io/cloudflare/sandbox:0.12.3",
              instance_type: "basic",
            },
            step_percentage: 25,
            kind: "full_auto",
          },
        },
      ],
    ]);
    expect(calls.containerRolloutGets).toEqual([
      ["application", "rollout", { account_id: "account" }],
    ]);
  } finally {
    await project.cleanup();
  }
});

test("deploy surfaces container rollout creation failures", async () => {
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
    rolloutCreateError: new Error("rollout failed"),
  });

  try {
    await expect(
      deployReady(calls, { cwd: project.cwd, env: deployEnv, client: () => client }),
    ).rejects.toThrow("rollout failed");
  } finally {
    await project.cleanup();
  }
});

test("deploy rejects a reverted container rollout", async () => {
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
    rolloutStatus: "reverted",
  });

  try {
    await expect(
      deployReady(calls, { cwd: project.cwd, env: deployEnv, client: () => client }),
    ).rejects.toThrow("container rollout reverted");
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
      deployReady(calls, {
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
    secrets: [
      { name: "LINEAR_WEBHOOK_SECRET" },
      { name: "LINEAR_API_KEY" },
      { name: "RUNWAY_SECRET_SNAPSHOT_KEY" },
    ],
  });

  try {
    await deployReady(calls, {
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
    expect(metadata.bindings).not.toContainEqual({
      type: "secret_text",
      name: "RUNWAY_SECRET_SNAPSHOT_KEY",
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
    const result = await deployReady(calls, {
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
      deployReady(emptyCalls(), {
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
