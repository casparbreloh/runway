import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { cron, github, webhook, workflow } from "runway";
import type { WorkflowDefinition } from "runway";
import { expect, test } from "vitest";

import { resolveAuth } from "../src/internal/auth.ts";
import type { WranglerCommand } from "../src/internal/auth.ts";
import { buildDeployment } from "../src/internal/publish/artifacts.ts";
import { publishWithAdapters } from "../src/internal/publish/publish.ts";
import type { CloudflareApi, ProgressEvent } from "../src/internal/publish/publish.ts";
import { cronsOf, type Registry } from "../src/internal/publish/registry.ts";
import type { RepositorySource } from "../src/internal/source/repository.ts";
import { assertRepositorySourceReachable } from "../src/internal/source/repository.ts";
import type {
  StackControl,
  StackManifest,
  StackReceipt,
  StackResource,
} from "../src/internal/stack/stack.ts";
import { authenticatedRepositoryFixture, repositoryFixture } from "./support/repository.ts";

const execFileAsync = promisify(execFile);

const registry: Registry = [
  {
    path: ".runway/workflows/hello.ts",
    exportName: "default",
    def: workflow({
      id: "hello",
      secrets: ["LINEAR_WEBHOOK_SECRET", "LINEAR_API_KEY"],
      trigger: (context) =>
        webhook({
          path: "/hello",
          secret: context.secrets.LINEAR_WEBHOOK_SECRET,
          signatureHeader: "linear-signature",
        }),
    }).run(async () => {}),
  },
  {
    path: ".runway/workflows/daily.ts",
    exportName: "daily",
    def: workflow({ id: "daily", trigger: () => cron("0 9 * * *") }).run(async () => {}),
  },
];

const githubRegistry: Registry = [
  {
    path: ".runway/workflows/check.ts",
    exportName: "default",
    def: workflow({
      id: "check",
      trigger: () => github({ checkName: "Check", events: [{ type: "push", branches: ["main"] }] }),
    }).run(async () => {}),
  },
];

const moduleOf = (name: string, definition: WorkflowDefinition): string =>
  `export ${name === "default" ? "default" : `const ${name} =`} { ...${JSON.stringify({ ...definition, run: undefined })}, run: async () => {} };\n`;

const writeProject = async (packageJson: object = { name: "ship-it" }) => {
  const cwd = await mkdtemp(
    path.join(path.resolve(import.meta.dirname, ".."), ".tmp-publish-test-"),
  );
  await mkdir(path.join(cwd, ".runway", "workflows"), { recursive: true });
  await writeFile(path.join(cwd, "package.json"), JSON.stringify(packageJson));
  for (const item of [...registry, ...githubRegistry]) {
    await writeFile(path.join(cwd, item.path), moduleOf(item.exportName, item.def));
  }
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};

class MemoryStack implements StackControl {
  readonly #state = new Map<string, { value: string; revision: string }>();
  #manifest: StackManifest | undefined;
  #revision = 0;
  applied = 0;

  urls(): readonly { id: string; url: string }[] {
    const name = this.#manifest?.owner.name ?? "missing";
    return [{ id: "hello", url: `https://${name}.example.workers.dev/hello` }];
  }

  apply(manifest: StackManifest): Promise<void> {
    this.#manifest = structuredClone(manifest);
    this.applied += 1;
    return Promise.resolve();
  }

  inventory(manifest: StackManifest): Promise<StackReceipt> {
    if (this.#manifest?.generation !== manifest.generation)
      throw new Error("Stack was not applied");
    return Promise.resolve({
      owner: manifest.owner,
      generation: manifest.generation,
      worker: {
        ...manifest.worker,
        providerEtag: "provider-etag",
        versionId: "worker-version",
        deploymentId: "worker-deployment",
      },
      workflow: { ...manifest.workflow, id: "workflow-id" },
      container: {
        ...manifest.container,
        id: "container-id",
        rolloutId: "rollout-id",
        namespaceId: "namespace-RunwaySandbox",
      },
      namespaces: manifest.namespaces.map(({ binding, name, className }) => ({
        binding,
        name,
        className,
        id: `namespace-${binding}`,
        scriptName: manifest.worker.name,
      })),
      schedules: manifest.schedules,
      workersDev: manifest.workersDev,
      bindings: manifest.bindings,
      secretNames: manifest.secretNames,
      secretSnapshot: manifest.secretSnapshot,
      buckets: manifest.buckets.map((bucket) => ({
        ...bucket,
        objects: bucket.objects.map((object) => ({ ...object, etag: `etag-${object.key}` })),
      })),
      routes: [],
    });
  }

  read(key: string): Promise<{ value: string; revision: string } | undefined> {
    return Promise.resolve(structuredClone(this.#state.get(key)));
  }

  list(prefix: string): Promise<readonly { key: string; value: string; revision: string }[]> {
    return Promise.resolve(
      [...this.#state.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, ...value })),
    );
  }

  writeOnce(key: string, value: string): Promise<void> {
    const current = this.#state.get(key);
    if (current && current.value !== value) throw new Error("immutable state changed");
    if (!current) {
      this.#revision += 1;
      this.#state.set(key, { value, revision: String(this.#revision) });
    }
    return Promise.resolve();
  }

  deleteState(key: string, revision: string): Promise<void> {
    if (this.#state.get(key)?.revision === revision) this.#state.delete(key);
    return Promise.resolve();
  }

  deleteResource(_resource: StackResource): Promise<void> {
    throw new Error("unexpected stale resource");
  }

  hasResource(_resource: StackResource): Promise<boolean> {
    return Promise.resolve(false);
  }
}

const cloudflare = (secrets: readonly string[] = []): CloudflareApi =>
  ({
    accounts: { list: async () => [{ id: "account" }] },
    workers: {
      scripts: {
        secrets: { list: async () => secrets.map((name) => ({ name })) },
      },
    },
  }) as unknown as CloudflareApi;

const environment = {
  CLOUDFLARE_API_TOKEN: "token",
  CLOUDFLARE_ACCOUNT_ID: "account",
  LINEAR_WEBHOOK_SECRET: "secret-value",
  LINEAR_API_KEY: "key-value",
};

const githubEnvironment = {
  ...environment,
  RUNWAY_GITHUB_APP_ID: "12345",
  RUNWAY_GITHUB_PRIVATE_KEY: "private-key",
  RUNWAY_GITHUB_WEBHOOK_SECRET: "webhook-secret",
};

const githubProvider = {
  resolveRepository: async () => ({
    installationId: 42,
    repository: { id: 202, name: "runway", fullName: "casparbreloh/runway" },
  }),
  createInstallationToken: async () => ({ token: "ephemeral", expiresAt: "2026-07-17T12:30:00Z" }),
};

test("publish builds and syncs one exact digest-pinned Stack", async () => {
  const project = await writeProject();
  const stack = new MemoryStack();
  let manifest: StackManifest | undefined;
  try {
    const result = await publishWithAdapters(
      registry,
      { cwd: project.cwd, env: environment },
      {
        client: () => cloudflare(),
        repository: {
          ...repositoryFixture,
          remote: "https://github.com/casparbreloh/ship-it",
        },
        reachable: async () => {},
        stack: (value) => {
          manifest = value;
          return stack;
        },
      },
    );

    expect(stack.applied).toBe(1);
    expect(result.name).toBe("runway-ship-it");
    expect(result.urls).toEqual([
      { id: "hello", url: "https://runway-ship-it.example.workers.dev/hello" },
    ]);
    expect(manifest).toMatchObject({
      owner: { name: "runway-ship-it" },
      container: {
        name: "runway-ship-it",
        image:
          "docker.io/cloudflare/sandbox@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042",
        imageDigest: "sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042",
        platform: { os: "linux", architecture: "amd64" },
        instanceType: "standard-4",
      },
      schedules: ["0 9 * * *"],
      namespaces: expect.arrayContaining([
        expect.objectContaining({ name: "runway-ship-it_RunwayGitHubCoordinator" }),
        expect.objectContaining({ name: "runway-ship-it_Sandbox" }),
      ]),
    });
    expect(manifest!.buckets.map(({ name }) => name)).toEqual(["runway-data", "runway-state"]);
  } finally {
    await project.cleanup();
  }
});

test("package metadata and environment variables cannot configure deployment identity", async () => {
  const project = await writeProject({
    name: "unrelated-package-name",
    runway: { name: "ignored-package-configuration" },
  });
  try {
    const manifests: StackManifest[] = [];
    const stack = new MemoryStack();
    await expect(
      publishWithAdapters(
        registry,
        { cwd: project.cwd, env: { ...environment, RUNWAY_NAME: "runway-ignored" } },
        {
          client: () => cloudflare(),
          repository: repositoryFixture,
          reachable: async () => {},
          stack: (manifest) => {
            manifests.push(manifest);
            return stack;
          },
        },
      ),
    ).resolves.toMatchObject({ name: "runway" });

    expect(manifests).toHaveLength(1);
  } finally {
    await project.cleanup();
  }
});

test("GitHub publication derives stable repository ownership and never serializes credentials", async () => {
  const project = await writeProject();
  const stack = new MemoryStack();
  let manifest: StackManifest | undefined;
  let source: RepositorySource | undefined;
  try {
    await publishWithAdapters(
      githubRegistry,
      { cwd: project.cwd, env: githubEnvironment },
      {
        client: () => cloudflare(),
        repository: repositoryFixture,
        github: githubProvider,
        reachable: async (value) => {
          source = value;
        },
        stack: (value) => {
          manifest = value;
          return stack;
        },
      },
    );
    expect(source).toEqual({
      remote: "https://github.com/casparbreloh/runway",
      commit: repositoryFixture.commit,
      authentication: {
        type: "github",
        installationId: 42,
        repository: { id: 202, name: "runway", fullName: "casparbreloh/runway" },
      },
    });
    expect(manifest!.owner.repositoryId).toBe("github:202");
    expect(JSON.stringify(manifest)).not.toMatch(/private-key|webhook-secret|ephemeral/);
  } finally {
    await project.cleanup();
  }
});

test("publish validates required and reserved secrets before Stack state or provider mutation", async () => {
  const project = await writeProject();
  const stack = new MemoryStack();
  try {
    await expect(
      publishWithAdapters(
        registry,
        {
          cwd: project.cwd,
          env: { CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "account" },
        },
        {
          client: () => cloudflare(),
          repository: repositoryFixture,
          reachable: async () => {},
          stack: () => stack,
        },
      ),
    ).rejects.toThrow("missing secret(s)");
    expect(stack.applied).toBe(0);

    const colliding: Registry = [
      {
        ...registry[1]!,
        def: workflow({
          id: "collision",
          secrets: ["RUNWAY_GITHUB_APP_ID"],
          trigger: () => cron("0 9 * * *"),
        }).run(async () => {}),
      },
    ];
    await expect(
      publishWithAdapters(
        colliding,
        { cwd: project.cwd, env: githubEnvironment },
        {
          client: () => cloudflare(),
          repository: repositoryFixture,
          reachable: async () => {},
          stack: () => stack,
        },
      ),
    ).rejects.toThrow("used by Runway GitHub App binding");
    expect(stack.applied).toBe(0);
  } finally {
    await project.cleanup();
  }
});

test("publish binds complete cache transport credentials and rejects partial configuration", async () => {
  const project = await writeProject();
  let manifest: StackManifest | undefined;
  try {
    await publishWithAdapters(
      registry,
      {
        cwd: project.cwd,
        env: {
          ...environment,
          RUNWAY_CACHE_R2_ACCESS_KEY_ID: "access-key",
          RUNWAY_CACHE_R2_SECRET_ACCESS_KEY: "secret-key",
        },
      },
      {
        client: () => cloudflare(),
        repository: repositoryFixture,
        reachable: async () => {},
        stack: (value) => {
          manifest = value;
          return new MemoryStack();
        },
      },
    );
    expect(manifest!.secretNames).toEqual(
      expect.arrayContaining([
        "RUNWAY_CACHE_R2_ACCESS_KEY_ID",
        "RUNWAY_CACHE_R2_SECRET_ACCESS_KEY",
      ]),
    );

    await expect(
      publishWithAdapters(
        registry,
        {
          cwd: project.cwd,
          env: { ...environment, RUNWAY_CACHE_R2_ACCESS_KEY_ID: "access-key" },
        },
        {
          client: () => cloudflare(),
          repository: repositoryFixture,
          reachable: async () => {},
          stack: () => new MemoryStack(),
        },
      ),
    ).rejects.toThrow("RUNWAY_CACHE_R2_SECRET_ACCESS_KEY");
  } finally {
    await project.cleanup();
  }
});

test("publish emits final progress only after Stack verification", async () => {
  const project = await writeProject();
  const progress: ProgressEvent[] = [];
  const stack = new MemoryStack();
  try {
    await publishWithAdapters(
      registry,
      { cwd: project.cwd, env: environment, onProgress: (event) => progress.push(event) },
      {
        client: () => cloudflare(),
        repository: repositoryFixture,
        reachable: async () => {},
        stack: () => stack,
      },
    );
    expect(progress.filter(({ step }) => step === "publish")).toEqual([
      { step: "publish", status: "start" },
      { step: "publish", status: "done" },
    ]);
  } finally {
    await project.cleanup();
  }
});

test("private repository reachability uses one ephemeral exact-prompt askpass", async () => {
  const token = "private-publish-installation-token";
  let askpass: string | undefined;
  await assertRepositorySourceReachable(authenticatedRepositoryFixture, {
    installationToken: async () => token,
    exec: async (file, args, options) => {
      expect(file).toBe("git");
      expect(args.join(" ")).not.toContain(token);
      if (!args.includes("fetch")) return { stdout: "" };
      expect(options.env?.RUNWAY_GITHUB_TOKEN).toBe(token);
      askpass = options.env?.GIT_ASKPASS;
      expect(await readFile(askpass!, "utf8")).not.toContain(token);
      await expect(
        execFileAsync(askpass!, ["Password for 'https://x-access-token@github.com': "], {
          encoding: "utf8",
          env: options.env,
        }),
      ).resolves.toMatchObject({ stdout: `${token}\n` });
      return { stdout: "" };
    },
  });
  await expect(readFile(askpass!, "utf8")).rejects.toBeDefined();
});

test("publish can still use Wrangler OAuth without exposing its token", async () => {
  const project = await writeProject();
  const command: WranglerCommand = async (args, options) => {
    expect(args).toEqual(["auth", "token", "--json"]);
    expect(options.stdio).toBe("capture");
    return { stdout: '{"type":"oauth","token":"oauth-token"}\n' };
  };
  try {
    const stack = new MemoryStack();
    await expect(
      publishWithAdapters(
        registry,
        {
          cwd: project.cwd,
          env: { LINEAR_WEBHOOK_SECRET: "secret", LINEAR_API_KEY: "key" },
        },
        {
          wranglerCommand: command,
          client: ({ apiToken }) => {
            expect(apiToken).toBe("oauth-token");
            return cloudflare();
          },
          repository: repositoryFixture,
          reachable: async () => {},
          stack: () => stack,
        },
      ),
    ).resolves.toBeDefined();
  } finally {
    await project.cleanup();
  }
});

test("the default Wrangler subprocess environment excludes workflow secrets", async () => {
  const directory = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "runway-wrangler-"));
  const wrangler = path.join(directory, "wrangler");
  await writeFile(
    wrangler,
    `#!/bin/sh
if [ -n "\${LINEAR_API_KEY-}\${WRANGLER_WORKFLOW_SECRET-}\${CLOUDFLARE_AUTH_WORKFLOW_SECRET-}" ]; then
  exit 41
fi
printf '{"type":"oauth","token":"oauth-token"}\\n'
`,
  );
  await chmod(wrangler, 0o755);
  try {
    await expect(
      resolveAuth(
        {
          cwd: directory,
          client: () => ({ accounts: { list: async () => [{ id: "account" }] } }) as CloudflareApi,
        },
        {
          PATH: directory,
          LINEAR_API_KEY: "workflow-secret",
          WRANGLER_WORKFLOW_SECRET: "workflow-secret",
          CLOUDFLARE_AUTH_WORKFLOW_SECRET: "workflow-secret",
        },
      ),
    ).resolves.toMatchObject({ accountId: "account" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("auth explains how to authenticate when Wrangler is not installed", async () => {
  await expect(resolveAuth({ cwd: "/repo" }, { PATH: "", HOME: process.env.HOME })).rejects.toThrow(
    "install Wrangler and run `wrangler login`, or set CLOUDFLARE_API_TOKEN",
  );
});

test("interactive auth launches the ordinary Wrangler login and retries the token", async () => {
  const calls: ReadonlyArray<string>[] = [];
  const command: WranglerCommand = async (args, options) => {
    calls.push(args);
    if (args[0] === "login") {
      expect(options.stdio).toBe("inherit");
      return { stdout: "" };
    }
    expect(options.stdio).toBe("capture");
    return calls.length === 1
      ? { stdout: "", stderr: "Not logged in. Run wrangler login.", exitCode: 1 }
      : { stdout: '{"type":"oauth","token":"after-login"}' };
  };

  const auth = await resolveAuth(
    {
      cwd: "/repo",
      interactive: true,
      wranglerCommand: command,
      client: ({ apiToken }) => {
        expect(apiToken).toBe("after-login");
        return { accounts: { list: async () => [{ id: "account" }] } } as CloudflareApi;
      },
    },
    {},
  );

  expect(auth.accountId).toBe("account");
  expect(calls).toEqual([["auth", "token", "--json"], ["login"], ["auth", "token", "--json"]]);
});

test("Wrangler operational failures do not launch a new login", async () => {
  const calls: ReadonlyArray<string>[] = [];
  const command: WranglerCommand = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "failed to read Wrangler configuration", exitCode: 1 };
  };

  await expect(
    resolveAuth({ cwd: "/repo", interactive: true, wranglerCommand: command }, {}),
  ).rejects.toThrow("Wrangler authentication check failed");
  expect(calls).toEqual([["auth", "token", "--json"]]);
});

test("interactive auth selects an accessible account and rejects invalid injected selections", async () => {
  const accounts = {
    list: async () => [
      { id: "one", name: "First" },
      { id: "two", name: "Second" },
    ],
  };
  const selected = await resolveAuth(
    {
      cwd: "/repo",
      interactive: true,
      accountSelector: async (available) => {
        expect(available).toEqual([
          { id: "one", name: "First" },
          { id: "two", name: "Second" },
        ]);
        return "two";
      },
      client: () => ({ accounts }) as CloudflareApi,
    },
    { CLOUDFLARE_API_TOKEN: "token" },
  );
  expect(selected.accountId).toBe("two");

  await expect(
    resolveAuth(
      {
        cwd: "/repo",
        interactive: true,
        accountSelector: async () => "other",
        client: () => ({ accounts }) as CloudflareApi,
      },
      { CLOUDFLARE_API_TOKEN: "token" },
    ),
  ).rejects.toThrow('selected Cloudflare account is not accessible: "other"');
});

test("auth preserves env-token precedence and never logs in when noninteractive, in CI, or disabled", async () => {
  let calls = 0;
  const command: WranglerCommand = async () => {
    calls += 1;
    return { stdout: "", stderr: "Not logged in. Run wrangler login.", exitCode: 1 };
  };
  const client = ({ apiToken }: { apiToken: string }) => {
    expect(apiToken).toBe("environment-token");
    return { accounts: { list: async () => [] } } as CloudflareApi;
  };

  await expect(
    resolveAuth(
      { cwd: "/repo", interactive: true, wranglerCommand: command, client },
      { CLOUDFLARE_API_TOKEN: "environment-token", CLOUDFLARE_ACCOUNT_ID: "account" },
    ),
  ).resolves.toMatchObject({ accountId: "account" });
  expect(calls).toBe(0);

  for (const [options, env] of [
    [{ cwd: "/repo", wranglerCommand: command }, {}],
    [{ cwd: "/repo", interactive: true, wranglerCommand: command }, { CI: "true" }],
    [{ cwd: "/repo", interactive: true, wranglerAuth: false, wranglerCommand: command }, {}],
  ] as const) {
    const before = calls;
    await expect(resolveAuth(options, env)).rejects.toThrow("Cloudflare authentication required");
    expect(calls - before).toBe("wranglerAuth" in options ? 0 : 1);
  }
});

test("GitHub publish validates local App configuration and preserves a remote webhook secret", async () => {
  const project = await writeProject();
  try {
    await expect(
      publishWithAdapters(
        githubRegistry,
        {
          cwd: project.cwd,
          env: { ...environment, RUNWAY_GITHUB_WEBHOOK_SECRET: "webhook" },
        },
        {
          client: () => cloudflare(),
          repository: repositoryFixture,
          reachable: async () => {},
          stack: () => new MemoryStack(),
        },
      ),
    ).rejects.toThrow("missing GitHub App publish config");

    await expect(
      publishWithAdapters(
        githubRegistry,
        {
          cwd: project.cwd,
          env: {
            ...environment,
            RUNWAY_GITHUB_APP_ID: "12345",
            RUNWAY_GITHUB_PRIVATE_KEY: "private-key",
          },
        },
        {
          client: () => cloudflare(),
          repository: repositoryFixture,
          github: githubProvider,
          reachable: async () => {},
          stack: () => new MemoryStack(),
        },
      ),
    ).rejects.toThrow("missing GitHub App secret");

    let manifest: StackManifest | undefined;
    await publishWithAdapters(
      githubRegistry,
      {
        cwd: project.cwd,
        env: {
          ...environment,
          RUNWAY_GITHUB_APP_ID: "12345",
          RUNWAY_GITHUB_PRIVATE_KEY: "private-key",
        },
      },
      {
        client: () => cloudflare(["RUNWAY_GITHUB_WEBHOOK_SECRET"]),
        repository: repositoryFixture,
        github: githubProvider,
        reachable: async () => {},
        stack: (value) => {
          manifest = value;
          return new MemoryStack();
        },
      },
    );
    expect(manifest!.secretNames).toContain("RUNWAY_GITHUB_WEBHOOK_SECRET");
  } finally {
    await project.cleanup();
  }
});

test("GitHub credentials do not authenticate a non-GitHub public repository", async () => {
  const project = await writeProject();
  let resolutions = 0;
  const repository: RepositorySource = {
    remote: "https://gitlab.example/acme/runway.git",
    commit: repositoryFixture.commit,
    authentication: { type: "public" },
  };
  try {
    await publishWithAdapters(
      registry,
      { cwd: project.cwd, env: githubEnvironment },
      {
        client: () => cloudflare(),
        repository,
        github: {
          ...githubProvider,
          resolveRepository: async () => {
            resolutions += 1;
            return await githubProvider.resolveRepository();
          },
        },
        reachable: async (value) => expect(value).toEqual(repository),
        stack: () => new MemoryStack(),
      },
    );
    expect(resolutions).toBe(0);
  } finally {
    await project.cleanup();
  }
});

test("repository reachability rejects identity drift and never authenticates public source", async () => {
  let tokenMints = 0;
  await assertRepositorySourceReachable(repositoryFixture, {
    installationToken: async () => {
      tokenMints += 1;
      return "unused";
    },
    exec: async () => ({ stdout: "" }),
  });
  expect(tokenMints).toBe(0);

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

test("publish stops before Stack mutation when the source commit is unavailable", async () => {
  const project = await writeProject();
  const stack = new MemoryStack();
  try {
    await expect(
      publishWithAdapters(
        registry,
        { cwd: project.cwd, env: environment },
        {
          client: () => cloudflare(),
          repository: repositoryFixture,
          reachable: async () => {
            throw new Error("source commit unavailable");
          },
          stack: () => stack,
        },
      ),
    ).rejects.toThrow("source commit unavailable");
    expect(stack.applied).toBe(0);
  } finally {
    await project.cleanup();
  }
});

test("workflows without triggers bundle immutable artifacts without ingress", async () => {
  const project = await writeProject();
  const definition = workflow({ id: "example" }).run(async () => {});
  const untriggeredRegistry: Registry = [
    { path: ".runway/workflows/example.ts", exportName: "default", def: definition },
  ];
  try {
    await writeFile(
      path.join(project.cwd, untriggeredRegistry[0]!.path),
      moduleOf("default", definition),
    );
    const deployment = await buildDeployment(untriggeredRegistry, {
      accountId: "account",
      cwd: project.cwd,
      deploymentName: "runway-example",
      repository: repositoryFixture,
      snapshotKeyAvailable: true,
    });
    expect(deployment.artifacts.map((artifact) => artifact.workflowId)).toEqual(["example"]);
    expect(cronsOf(untriggeredRegistry)).toEqual([]);
  } finally {
    await project.cleanup();
  }
});

test("artifact identities stay stable until workflow source changes", async () => {
  const project = await writeProject();
  const publishProject = async () =>
    await publishWithAdapters(
      registry,
      { cwd: project.cwd, env: environment },
      {
        client: () => cloudflare(),
        repository: repositoryFixture,
        reachable: async () => {},
        stack: () => new MemoryStack(),
      },
    );
  try {
    const first = await publishProject();
    const unchanged = await publishProject();
    expect(unchanged.artifactVersions).toEqual(first.artifactVersions);

    const hello = registry[0]!;
    await writeFile(
      path.join(project.cwd, hello.path),
      moduleOf(hello.exportName, hello.def).replace(
        "run: async () => {}",
        'run: async () => { return "changed"; }',
      ),
    );
    const changed = await publishProject();
    expect(changed.artifactVersions[0]).not.toBe(first.artifactVersions[0]);
    expect(changed.artifactVersions[1]).toBe(first.artifactVersions[1]);
  } finally {
    await project.cleanup();
  }
});

test("publish accepts remote secrets and requires explicit account selection for ambiguous auth", async () => {
  const project = await writeProject();
  try {
    await expect(
      publishWithAdapters(
        registry,
        {
          cwd: project.cwd,
          env: { CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "account" },
        },
        {
          client: () => cloudflare(["LINEAR_API_KEY", "LINEAR_WEBHOOK_SECRET"]),
          repository: repositoryFixture,
          reachable: async () => {},
          stack: () => new MemoryStack(),
        },
      ),
    ).resolves.toBeDefined();

    await expect(
      publishWithAdapters(
        registry,
        {
          cwd: project.cwd,
          env: {
            CLOUDFLARE_API_TOKEN: "token",
            LINEAR_API_KEY: "key",
            LINEAR_WEBHOOK_SECRET: "secret",
          },
        },
        {
          client: () =>
            ({ accounts: { list: async () => [{ id: "one" }, { id: "two" }] } }) as CloudflareApi,
          repository: repositoryFixture,
          reachable: async () => {},
          stack: () => new MemoryStack(),
        },
      ),
    ).rejects.toThrow("CLOUDFLARE_ACCOUNT_ID");
  } finally {
    await project.cleanup();
  }
});
