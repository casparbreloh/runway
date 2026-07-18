import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { cron, github, webhook, workflow } from "runway";
import type { WorkflowDefinition } from "runway";
import { expect, test } from "vitest";

import { deployWithAdapters } from "../src/deploy.ts";
import type { CloudflareApi, ProgressEvent } from "../src/deploy.ts";
import type { Registry } from "../src/internal/deploy/registry.ts";
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
    path.join(path.resolve(import.meta.dirname, ".."), ".tmp-deploy-test-"),
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

test("deploy builds and syncs one exact digest-pinned Stack", async () => {
  const project = await writeProject();
  const stack = new MemoryStack();
  let manifest: StackManifest | undefined;
  try {
    const result = await deployWithAdapters(
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
        expect.objectContaining({ name: "runway-ship-it-github" }),
        expect.objectContaining({ name: "runway-ship-it-sandbox" }),
      ]),
    });
    expect(manifest!.buckets.map(({ name }) => name)).toEqual(["runway-data", "runway-state"]);
  } finally {
    await project.cleanup();
  }
});

test("package metadata cannot configure deployment identity", async () => {
  const project = await writeProject({
    name: "unrelated-package-name",
    runway: { name: "ignored-package-configuration" },
  });
  try {
    const manifests: StackManifest[] = [];
    const stack = new MemoryStack();
    await expect(
      deployWithAdapters(
        registry,
        { cwd: project.cwd, env: environment },
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

    await expect(
      deployWithAdapters(
        registry,
        { cwd: project.cwd, env: { ...environment, RUNWAY_NAME: "runway-smoke" } },
        {
          client: () => cloudflare(),
          repository: repositoryFixture,
          reachable: async () => {},
          stack: (manifest) => {
            manifests.push(manifest);
            return new MemoryStack();
          },
        },
      ),
    ).resolves.toMatchObject({ name: "runway-smoke" });
    expect(manifests[0]?.owner.stackId).not.toBe(manifests[1]?.owner.stackId);
  } finally {
    await project.cleanup();
  }
});

test("GitHub deployment derives stable repository ownership and never serializes credentials", async () => {
  const project = await writeProject();
  const stack = new MemoryStack();
  let manifest: StackManifest | undefined;
  let source: RepositorySource | undefined;
  try {
    await deployWithAdapters(
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

test("deploy validates required and reserved secrets before Stack state or provider mutation", async () => {
  const project = await writeProject();
  const stack = new MemoryStack();
  try {
    await expect(
      deployWithAdapters(
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
      deployWithAdapters(
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

test("deploy emits final progress only after Stack verification", async () => {
  const project = await writeProject();
  const progress: ProgressEvent[] = [];
  const stack = new MemoryStack();
  try {
    await deployWithAdapters(
      registry,
      { cwd: project.cwd, env: environment, onProgress: (event) => progress.push(event) },
      {
        client: () => cloudflare(),
        repository: repositoryFixture,
        reachable: async () => {},
        stack: () => stack,
      },
    );
    expect(progress.filter(({ step }) => step === "deploy")).toEqual([
      { step: "deploy", status: "start" },
      { step: "deploy", status: "done" },
    ]);
  } finally {
    await project.cleanup();
  }
});

test("private repository reachability uses one ephemeral exact-prompt askpass", async () => {
  const token = "private-deploy-installation-token";
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

test("deploy can still use Wrangler OAuth without exposing its token", async () => {
  const project = await writeProject();
  const bin = path.join(project.cwd, ".bin");
  await mkdir(bin);
  const wrangler = path.join(bin, "wrangler");
  await writeFile(wrangler, '#!/bin/sh\nprintf \'{"type":"oauth","token":"oauth-token"}\\n\'\n');
  await chmod(wrangler, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    const stack = new MemoryStack();
    await expect(
      deployWithAdapters(
        registry,
        {
          cwd: project.cwd,
          env: { LINEAR_WEBHOOK_SECRET: "secret", LINEAR_API_KEY: "key" },
        },
        {
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
    process.env.PATH = previousPath;
    await project.cleanup();
  }
});

test("GitHub deploy validates local App configuration and preserves a remote webhook secret", async () => {
  const project = await writeProject();
  try {
    await expect(
      deployWithAdapters(
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
    ).rejects.toThrow("missing GitHub App deploy config");

    await expect(
      deployWithAdapters(
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
    await deployWithAdapters(
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
    await deployWithAdapters(
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

test("deploy stops before Stack mutation when the source commit is unavailable", async () => {
  const project = await writeProject();
  const stack = new MemoryStack();
  try {
    await expect(
      deployWithAdapters(
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

test("artifact identities stay stable until workflow source changes", async () => {
  const project = await writeProject();
  const deployProject = async () =>
    await deployWithAdapters(
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
    const first = await deployProject();
    const unchanged = await deployProject();
    expect(unchanged.artifactVersions).toEqual(first.artifactVersions);

    const hello = registry[0]!;
    await writeFile(
      path.join(project.cwd, hello.path),
      moduleOf(hello.exportName, hello.def).replace(
        "run: async () => {}",
        'run: async () => { return "changed"; }',
      ),
    );
    const changed = await deployProject();
    expect(changed.artifactVersions[0]).not.toBe(first.artifactVersions[0]);
    expect(changed.artifactVersions[1]).toBe(first.artifactVersions[1]);
  } finally {
    await project.cleanup();
  }
});

test("deploy accepts remote secrets and requires explicit account selection for ambiguous auth", async () => {
  const project = await writeProject();
  try {
    await expect(
      deployWithAdapters(
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
      deployWithAdapters(
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
