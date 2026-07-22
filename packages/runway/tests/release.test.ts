import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import type { CloudflareApi } from "../src/internal/cloudflare.ts";
import { connectGitHub, releaseFromBuild } from "../src/internal/connect.ts";
import type { PreparedRelease } from "../src/internal/publish/artifacts.ts";
import { loadRegistry } from "../src/internal/publish/registry.ts";
import { CloudflareReleaseControl } from "../src/internal/release/cloudflare.ts";
import { HttpReleaseControl } from "../src/internal/release/http.ts";
import {
  activeReleaseKey,
  decodeActiveRelease,
  decodeReleaseRegistry,
  encodeReleaseRegistry,
  releaseRegistryKey,
  type ReleaseRegistry,
} from "../src/internal/release/registry.ts";
import { assertReleasePolicy } from "../src/internal/release/runtime.ts";

const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

test("release policy rejects substituted GitHub ingress identity", () => {
  const authentication = {
    type: "github" as const,
    installationId: 42,
    repository: { id: 101, name: "runway", fullName: "example/runway" },
  };
  const registry: ReleaseRegistry = {
    schema: 1,
    deploymentName: "runway",
    defaultBranch: "main",
    repository: {
      remote: "https://github.com/example/runway",
      commit: "a".repeat(40),
      authentication,
    },
    github: {
      installationId: 43,
      repository: { id: 102, name: "other", fullName: "attacker/other" },
    },
    secretNames: [],
    routes: [
      {
        id: "check",
        artifactVersion: "b".repeat(64),
        type: "github",
        checkName: "Check",
        events: [{ type: "push", branches: ["main"] }],
      },
    ],
  };

  expect(() =>
    assertReleasePolicy(registry, {
      deploymentName: "runway",
      authorSecretNames: [],
      repository: { remote: registry.repository.remote, authentication },
      defaultBranch: "main",
      github: {
        installationId: authentication.installationId,
        repository: authentication.repository,
      },
    }),
  ).toThrow("release does not match structural policy");
});

const release = (commit = "a".repeat(40)): PreparedRelease => {
  const contents = new TextEncoder().encode("workflow");
  const artifactVersion = digest(contents);
  const registry: ReleaseRegistry = {
    schema: 1,
    deploymentName: "runway",
    defaultBranch: "main",
    repository: {
      remote: "https://github.com/example/runway",
      commit,
      authentication: { type: "public" },
    },
    secretNames: [],
    routes: [{ id: "check", artifactVersion, type: "cron", expression: "0 9 * * *" }],
  };
  const registryContents = encodeReleaseRegistry(registry);
  return {
    artifacts: [{ workflowId: "check", artifactVersion, contents }],
    registry,
    registryContents,
    registryVersion: digest(registryContents),
  };
};

const memoryCloudflare = () => {
  const objects = new Map<string, { contents: Uint8Array; etag: string }>();
  const operations: string[] = [];
  let revision = 0;
  const error = (status: number): Error => Object.assign(new Error(String(status)), { status });
  const cf = {
    r2: {
      buckets: {
        objects: {
          get: async (key: string) => {
            operations.push(`get:${key}`);
            const object = objects.get(key);
            if (!object) throw error(404);
            return new Response(object.contents, { headers: { etag: object.etag } });
          },
          upload: async (
            key: string,
            body: Uint8Array,
            _params: unknown,
            options?: { headers?: Readonly<Record<string, string>> },
          ) => {
            operations.push(`put:${key}`);
            const existing = objects.get(key);
            if (options?.headers?.["If-None-Match"] === "*" && existing) throw error(412);
            if (
              options?.headers?.["If-Match"] !== undefined &&
              options.headers["If-Match"] !== existing?.etag
            ) {
              throw error(412);
            }
            revision += 1;
            objects.set(key, { contents: new Uint8Array(body), etag: `etag-${revision}` });
          },
        },
      },
    },
  } as unknown as CloudflareApi;
  return { cf, objects, operations };
};

const control = (
  cf: CloudflareApi,
  isAncestor?: (ancestor: string, descendant: string) => Promise<boolean>,
) =>
  new CloudflareReleaseControl({
    cf,
    accountId: "account",
    bucket: "runway-data",
    deploymentName: "runway",
    ...(isAncestor ? { isAncestor } : {}),
  });

test("release registries are canonical and strictly decoded", () => {
  const prepared = release();
  expect(decodeReleaseRegistry(prepared.registryContents)).toEqual(prepared.registry);
  expect(() =>
    decodeReleaseRegistry(
      new TextEncoder().encode(
        JSON.stringify({
          ...prepared.registry,
          routes: [{ ...prepared.registry.routes[0], id: "Bad" }],
        }),
      ),
    ),
  ).toThrow("invalid release registry");
  expect(() =>
    decodeActiveRelease(
      new TextEncoder().encode(
        JSON.stringify({ schema: 1, commit: "bad", registryVersion: "b".repeat(64) }),
      ),
    ),
  ).toThrow("invalid active release");
});

test("activation verifies immutable objects and advances the pointer last", async () => {
  const memory = memoryCloudflare();
  const prepared = release();
  await expect(control(memory.cf).activate(prepared)).resolves.toMatchObject({ changed: true });

  const artifactPut = memory.operations.indexOf(
    `put:artifacts/${prepared.artifacts[0]!.artifactVersion}.json`,
  );
  const registryPut = memory.operations.indexOf(
    `put:${releaseRegistryKey("runway", prepared.registryVersion)}`,
  );
  const activePut = memory.operations.indexOf(`put:${activeReleaseKey("runway")}`);
  expect(artifactPut).toBeGreaterThanOrEqual(0);
  expect(registryPut).toBeGreaterThan(artifactPut);
  expect(activePut).toBeGreaterThan(registryPut);

  memory.operations.length = 0;
  await expect(control(memory.cf).activate(prepared)).resolves.toMatchObject({ changed: false });
  expect(memory.operations.filter((operation) => operation.startsWith("put:"))).toEqual([]);
});

test("HTTP activation transfers immutable bodies only when preflight reports them missing", async () => {
  const prepared = release();
  const uploads: Array<Record<string, unknown>> = [];
  let cold = true;
  const request = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method === "PUT") {
      return Response.json({
        schema: 1,
        missingRegistry: cold,
        missingArtifacts: cold
          ? prepared.artifacts.map(({ workflowId, artifactVersion }) => ({
              workflowId,
              artifactVersion,
            }))
          : [],
      });
    }
    if (init?.method === "POST") {
      uploads.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const changed = cold;
      cold = false;
      return Response.json({
        changed,
        active: {
          schema: 1,
          commit: prepared.registry.repository.commit,
          registryVersion: prepared.registryVersion,
        },
      });
    }
    throw new Error("unexpected release request");
  };
  const control = new HttpReleaseControl({
    url: "https://runway.example/runway/release",
    token: "token",
    fetch: request as typeof fetch,
  });

  await control.activate(prepared, null);
  await control.activate(prepared, {
    schema: 1,
    commit: prepared.registry.repository.commit,
    registryVersion: prepared.registryVersion,
  });

  expect(uploads[0]).toHaveProperty("registryContents");
  expect(uploads[0]!.artifacts).toEqual([
    expect.objectContaining({ contents: expect.any(String) }),
  ]);
  expect(uploads[1]).not.toHaveProperty("registryContents");
  expect(uploads[1]!.artifacts).toEqual([
    {
      workflowId: prepared.artifacts[0]!.workflowId,
      artifactVersion: prepared.artifacts[0]!.artifactVersion,
    },
  ]);
});

test("activation rejects immutable conflicts and stale commits", async () => {
  const memory = memoryCloudflare();
  const first = release("b".repeat(40));
  await control(memory.cf).activate(first);

  const stale = release("a".repeat(40));
  await expect(control(memory.cf, async () => false).activate(stale)).rejects.toThrow(
    "was superseded",
  );

  memory.objects.set(`artifacts/${stale.artifacts[0]!.artifactVersion}.json`, {
    contents: new TextEncoder().encode("conflict"),
    etag: "conflict",
  });
  await expect(control(memory.cf).activate(stale)).rejects.toThrow(
    "immutable release object conflict",
  );
});

const execFileAsync = promisify(execFile);

const repository = async (): Promise<{
  readonly cwd: string;
  readonly commit: string;
  cleanup(): Promise<void>;
}> => {
  const cwd = await mkdtemp(path.join(import.meta.dirname, ".tmp-connect-test-"));
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], { cwd });
  await execFileAsync("git", ["config", "user.email", "runway@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Runway"], { cwd });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/runway.git"], {
    cwd,
  });
  await writeFile(path.join(cwd, ".gitignore"), "ignored\n.runway/workflows/ignored.ts\n");
  await writeFile(path.join(cwd, "tracked"), "committed\n");
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  return {
    cwd,
    commit: stdout.trim(),
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
};

const dirtyCases = {
  tracked: async (cwd: string) => await writeFile(path.join(cwd, "tracked"), "changed\n"),
  staged: async (cwd: string) => {
    await writeFile(path.join(cwd, "tracked"), "changed\n");
    await execFileAsync("git", ["add", "tracked"], { cwd });
  },
  untracked: async (cwd: string) => await writeFile(path.join(cwd, "untracked"), "new\n"),
} as const;

test.each(Object.entries(dirtyCases))(
  "connect rejects a dirty Git worktree with %s changes before provider access",
  async (_kind, makeDirty) => {
    const project = await repository();
    let requests = 0;
    try {
      await makeDirty(project.cwd);
      await expect(
        connectGitHub([], {
          cwd: project.cwd,
          fetch: async () => {
            requests += 1;
            throw new Error("unexpected provider access");
          },
        }),
      ).rejects.toThrow("Git worktree is dirty");
      expect(requests).toBe(0);
    } finally {
      await project.cleanup();
    }
  },
);

test("connect allows ignored files", async () => {
  const project = await repository();
  let requests = 0;
  try {
    await writeFile(path.join(project.cwd, "ignored"), "local\n");
    await expect(
      connectGitHub([], {
        cwd: project.cwd,
        fetch: async () => {
          requests += 1;
          throw new Error("GitHub metadata requested");
        },
      }),
    ).rejects.toThrow("GitHub metadata requested");
    expect(requests).toBe(1);
  } finally {
    await project.cleanup();
  }
});

test("committed registry loading rejects ignored imported source before execution", async () => {
  const project = await repository();
  try {
    await mkdir(path.join(project.cwd, ".runway/workflows"), { recursive: true });
    await writeFile(
      path.join(project.cwd, "ignored"),
      "throw new Error('executed ignored source');\n",
    );
    await writeFile(
      path.join(project.cwd, ".runway/workflows/check.ts"),
      'import "../../ignored";\nimport { workflow } from "runway";\nexport default workflow({ id: "check" }).run(async () => {});\n',
    );
    await execFileAsync("git", ["add", ".runway/workflows/check.ts"], { cwd: project.cwd });
    await execFileAsync("git", ["commit", "--quiet", "-m", "workflow"], {
      cwd: project.cwd,
    });

    await expect(loadRegistry(project.cwd, { committed: true })).rejects.toThrow(
      "workflow source is not committed: ignored",
    );

    await writeFile(
      path.join(project.cwd, ".runway/workflows/check.ts"),
      'import { workflow } from "runway";\nexport default workflow({ id: "check" }).run(async () => {});\n',
    );
    await execFileAsync("git", ["add", ".runway/workflows/check.ts"], { cwd: project.cwd });
    await execFileAsync("git", ["commit", "--quiet", "-m", "remove ignored import"], {
      cwd: project.cwd,
    });
    await expect(loadRegistry(project.cwd, { committed: true })).resolves.toMatchObject([
      { def: { id: "check" } },
    ]);
  } finally {
    await project.cleanup();
  }
});

test("committed registry loading rejects ambient dependencies outside the repository", async () => {
  const project = await repository();
  const outside = await mkdtemp(path.join(import.meta.dirname, ".tmp-outside-source-"));
  try {
    const ambient = path.join(outside, "node_modules/ambient.ts");
    await mkdir(path.dirname(ambient), { recursive: true });
    await writeFile(ambient, "export {};\n");
    await mkdir(path.join(project.cwd, ".runway/workflows"), { recursive: true });
    await writeFile(
      path.join(project.cwd, ".runway/workflows/check.ts"),
      `import ${JSON.stringify(ambient)};\nimport { workflow } from "runway";\nexport default workflow({ id: "check" }).run(async () => {});\n`,
    );
    await execFileAsync("git", ["add", ".runway/workflows/check.ts"], { cwd: project.cwd });
    await execFileAsync("git", ["commit", "--quiet", "-m", "workflow"], {
      cwd: project.cwd,
    });

    await expect(loadRegistry(project.cwd, { committed: true })).rejects.toThrow(
      "workflow source is outside the repository",
    );
  } finally {
    await Promise.all([project.cleanup(), rm(outside, { recursive: true, force: true })]);
  }
});

test("connect rejects ignored workflow files before provider access", async () => {
  const project = await repository();
  let requests = 0;
  try {
    await mkdir(path.join(project.cwd, ".runway/workflows"), { recursive: true });
    await writeFile(path.join(project.cwd, ".runway/workflows/ignored.ts"), "sideEffect();\n");
    await expect(
      connectGitHub([], {
        cwd: project.cwd,
        fetch: async () => {
          requests += 1;
          throw new Error("unexpected provider access");
        },
      }),
    ).rejects.toThrow("ignored workflow files cannot be published");
    expect(requests).toBe(0);
  } finally {
    await project.cleanup();
  }
});

test("Workers Builds rejects a dirty Git worktree before building a release", async () => {
  const project = await repository();
  try {
    await writeFile(path.join(project.cwd, "untracked"), "new\n");
    await expect(
      releaseFromBuild([], {
        cwd: project.cwd,
        env: {
          WORKERS_CI: "1",
          WORKERS_CI_COMMIT_SHA: project.commit,
          WORKERS_CI_BRANCH: "main",
          RUNWAY_RELEASE_URL: "https://runway.example/runway/release",
          RUNWAY_RELEASE_TOKEN: "token",
          RUNWAY_ACCOUNT_ID: "account",
        },
      }),
    ).rejects.toThrow("Git worktree is dirty");
  } finally {
    await project.cleanup();
  }
});
