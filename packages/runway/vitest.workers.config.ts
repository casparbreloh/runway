import path from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { build as esbuild } from "esbuild";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

import { buildDeployment } from "./src/deploy-build.ts";
import type { Registry } from "./src/registry.ts";
import { secretRef } from "./src/secrets.ts";
import { cron, github, webhook } from "./src/trigger.ts";
import { COMPATIBILITY_DATE } from "./src/worker-contract.ts";
import { repositoryFixture } from "./tests/repository-fixture.ts";

const generatedHostRegistry: Registry = [
  {
    path: path.resolve(import.meta.dirname, "tests/runtime-worker.ts"),
    exportName: "issueCreated",
    def: {
      __kind: "workflow",
      id: "issue-created",
      secrets: ["HOOK_SECRET", "API_KEY"],
      trigger: webhook({
        path: "/issues",
        secret: secretRef("HOOK_SECRET"),
        signatureHeader: "x-signature",
      }),
      run: async () => {},
    },
  },
];

const suspendedRunRegistry: Registry = [
  {
    ...generatedHostRegistry[0]!,
    exportName: "suspendedIssueCreated",
    def: {
      ...generatedHostRegistry[0]!.def,
      id: "suspended-workflow",
      secrets: ["SANDBOX_SECRET"],
      trigger: cron("0 0 * * *"),
    },
  },
];

const githubEvents = [
  {
    type: "push" as const,
    branches: ["main", "develop", "release-a", "release-b", "prune-trigger"],
  },
  { type: "pull_request" as const, actions: ["opened", "reopened", "synchronize"] as const },
] as const;

const githubRegistry: Registry = [
  {
    path: path.resolve(import.meta.dirname, "tests/runtime-worker.ts"),
    exportName: "githubCheck",
    def: {
      __kind: "workflow",
      id: "github-check",
      secrets: [],
      trigger: github({ checkName: "Check", events: githubEvents }),
      run: async () => {},
    },
  },
  {
    path: path.resolve(import.meta.dirname, "tests/runtime-worker.ts"),
    exportName: "githubTest",
    def: {
      __kind: "workflow",
      id: "github-test",
      secrets: [],
      trigger: github({ checkName: "Test", events: githubEvents }),
      run: async () => {},
    },
  },
];

const manyGithubRegistry: Registry = Array.from({ length: 40 }, (_, index) => ({
  path: path.resolve(import.meta.dirname, "tests/runtime-worker.ts"),
  exportName: "githubCheck",
  def: {
    __kind: "workflow" as const,
    id: `batch-${String(index).padStart(2, "0")}`,
    secrets: [],
    trigger: github({
      checkName: `Batch ${index}`,
      events: [{ type: "push", branches: ["main"] }],
    }),
    run: async () => {},
  },
}));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const generated = await buildDeployment(generatedHostRegistry, {
        accountId: "test-account",
        cwd: import.meta.dirname,
        scriptName: "generated-runway-host",
        repository: repositoryFixture,
        snapshotKeyAvailable: true,
      });
      const suspended = await buildDeployment(suspendedRunRegistry, {
        accountId: "test-account",
        cwd: import.meta.dirname,
        scriptName: "generated-runway-host",
        repository: repositoryFixture,
        snapshotKeyAvailable: true,
      });
      const githubHost = await buildDeployment(githubRegistry, {
        accountId: "test-account",
        cwd: import.meta.dirname,
        scriptName: "generated-github-host",
        repository: repositoryFixture,
        snapshotKeyAvailable: true,
        github: {
          repository: { id: 101, name: "runway", fullName: "casparbreloh/runway" },
          installationId: 42,
        },
      });
      const githubCheckArtifact = githubHost.artifacts.find(
        ({ workflowId }) => workflowId === "github-check",
      )!;
      const githubTestArtifact = githubHost.artifacts.find(
        ({ workflowId }) => workflowId === "github-test",
      )!;
      const manyGithubHost = await buildDeployment(manyGithubRegistry, {
        accountId: "test-account",
        cwd: import.meta.dirname,
        scriptName: "generated-many-github-host",
        repository: repositoryFixture,
        snapshotKeyAvailable: true,
        github: {
          repository: { id: 102, name: "runway-many", fullName: "casparbreloh/runway-many" },
          installationId: 43,
        },
      });
      const probe = await esbuild({
        bundle: true,
        entryPoints: [path.resolve(import.meta.dirname, "tests/repository-probe-worker.ts")],
        external: ["cloudflare:*", "node:*"],
        format: "esm",
        platform: "browser",
        write: false,
      });
      const probeWorker = probe.outputFiles?.[0];
      if (!probeWorker) throw new Error("esbuild returned no repository probe worker");
      const effects = await esbuild({
        bundle: true,
        entryPoints: [path.resolve(import.meta.dirname, "tests/runtime-worker.ts")],
        external: ["cloudflare:*", "node:*"],
        format: "esm",
        platform: "browser",
        write: false,
      });
      const effectsWorker = effects.outputFiles?.[0];
      if (!effectsWorker) throw new Error("esbuild returned no GitHub effects probe worker");
      const activeArtifact = generated.artifacts[0]!;
      const suspendedArtifact = suspended.artifacts[0]!;
      return {
        main: "./tests/runtime-worker.ts",
        miniflare: {
          workers: [
            {
              name: "github-effects-probe",
              compatibilityDate: COMPATIBILITY_DATE,
              compatibilityFlags: ["nodejs_compat"],
              modules: [
                {
                  type: "ESModule",
                  path: "index.js",
                  contents: effectsWorker.text,
                },
              ],
            },
            {
              name: "generated-runway-host",
              compatibilityDate: COMPATIBILITY_DATE,
              compatibilityFlags: ["nodejs_compat"],
              modules: [
                {
                  type: "ESModule",
                  path: "index.js",
                  contents: new TextDecoder().decode(generated.host),
                },
              ],
              bindings: {
                API_KEY: "test-api-key",
                HOOK_SECRET: "test-secret",
                SANDBOX_SECRET: "sandbox-secret",
                RUNWAY_SECRET_SNAPSHOT_KEY: '{"identity":"RUNWAY_SECRET_SNAPSHOT_KEY_TEST"}',
                RUNWAY_SECRET_SNAPSHOT_KEY_TEST:
                  '{"identity":"RUNWAY_SECRET_SNAPSHOT_KEY_TEST","key":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}',
              },
              workerLoaders: { LOADER: {} },
              r2Buckets: { RUNWAY_ARTIFACTS: "runway-test-artifacts" },
              workflows: {
                WORKFLOWS: {
                  name: "generated-workflow-test",
                  className: "DynamicWorkflow",
                },
              },
            },
            {
              name: "generated-runway-capture-host",
              compatibilityDate: COMPATIBILITY_DATE,
              compatibilityFlags: ["nodejs_compat"],
              modules: [
                {
                  type: "ESModule",
                  path: "index.js",
                  contents: new TextDecoder().decode(generated.host),
                },
              ],
              bindings: {
                API_KEY: "test-api-key",
                HOOK_SECRET: "test-secret",
                SANDBOX_SECRET: "sandbox-secret",
                RUNWAY_SECRET_SNAPSHOT_KEY: '{"identity":"RUNWAY_SECRET_SNAPSHOT_KEY_TEST"}',
                RUNWAY_SECRET_SNAPSHOT_KEY_TEST:
                  '{"identity":"RUNWAY_SECRET_SNAPSHOT_KEY_TEST","key":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}',
              },
              workerLoaders: { LOADER: {} },
              r2Buckets: { RUNWAY_ARTIFACTS: "runway-test-artifacts" },
              serviceBindings: {
                WORKFLOWS: {
                  name: "generated-workflow-capture",
                  entrypoint: "TestWorkflowCapture",
                },
              },
            },
            {
              name: "generated-workflow-capture",
              compatibilityDate: COMPATIBILITY_DATE,
              modules: [
                {
                  type: "ESModule",
                  path: "index.js",
                  contents: `import { WorkerEntrypoint } from "cloudflare:workers";
let captured;
export class TestWorkflowCapture extends WorkerEntrypoint {
  create(options) {
    captured = options.params;
    return { id: crypto.randomUUID() };
  }
  captured() { return captured; }
  reset() { captured = undefined; }
}`,
                },
              ],
            },
            {
              name: "generated-github-host",
              compatibilityDate: COMPATIBILITY_DATE,
              compatibilityFlags: ["nodejs_compat"],
              modules: [
                {
                  type: "ESModule",
                  path: "index.js",
                  contents: new TextDecoder().decode(githubHost.host),
                },
              ],
              bindings: {
                RUNWAY_GITHUB_APP_ID: "test-app",
                RUNWAY_GITHUB_PRIVATE_KEY: "test-private-key",
                RUNWAY_GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
                RUNWAY_SECRET_SNAPSHOT_KEY: '{"identity":"RUNWAY_SECRET_SNAPSHOT_KEY_TEST"}',
                RUNWAY_SECRET_SNAPSHOT_KEY_TEST:
                  '{"identity":"RUNWAY_SECRET_SNAPSHOT_KEY_TEST","key":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}',
              },
              workerLoaders: { LOADER: {} },
              r2Buckets: { RUNWAY_ARTIFACTS: "runway-test-artifacts" },
              durableObjects: {
                RUNWAY_GITHUB_COORDINATOR: "RunwayGitHubCoordinator",
              },
              workflows: {
                WORKFLOWS: {
                  name: "generated-github-workflow-test",
                  className: "DynamicWorkflow",
                },
              },
              serviceBindings: {
                RUNWAY_GITHUB_PROVIDER: {
                  name: "github-effects-probe",
                  entrypoint: "GitHubProviderProbe",
                },
                RUNWAY_GITHUB_WORKFLOW: {
                  name: "github-effects-probe",
                  entrypoint: "GitHubWorkflowProbe",
                },
                RUNWAY_GITHUB_CLOCK: {
                  name: "github-effects-probe",
                  entrypoint: "GitHubClockProbe",
                },
              },
            },
            {
              name: "generated-many-github-host",
              compatibilityDate: COMPATIBILITY_DATE,
              compatibilityFlags: ["nodejs_compat"],
              modules: [
                {
                  type: "ESModule",
                  path: "index.js",
                  contents: new TextDecoder().decode(manyGithubHost.host),
                },
              ],
              bindings: {
                RUNWAY_GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
                RUNWAY_SECRET_SNAPSHOT_KEY: '{"identity":"RUNWAY_SECRET_SNAPSHOT_KEY_TEST"}',
              },
              workerLoaders: { LOADER: {} },
              r2Buckets: { RUNWAY_ARTIFACTS: "runway-test-artifacts" },
              durableObjects: {
                RUNWAY_GITHUB_COORDINATOR: "RunwayGitHubCoordinator",
              },
              serviceBindings: {
                RUNWAY_GITHUB_PROVIDER: {
                  name: "github-effects-probe",
                  entrypoint: "GitHubProviderProbe",
                },
                RUNWAY_GITHUB_WORKFLOW: {
                  name: "github-effects-probe",
                  entrypoint: "GitHubWorkflowProbe",
                },
                RUNWAY_GITHUB_CLOCK: {
                  name: "github-effects-probe",
                  entrypoint: "GitHubClockProbe",
                },
              },
            },
            {
              name: "repository-probe-worker",
              compatibilityDate: COMPATIBILITY_DATE,
              compatibilityFlags: ["nodejs_compat"],
              modules: [
                {
                  type: "ESModule",
                  path: "index.js",
                  contents: probeWorker.text,
                },
              ],
              workerLoaders: { LOADER: {} },
              r2Buckets: { RUNWAY_ARTIFACTS: "runway-test-artifacts" },
              bindings: {
                RUNWAY_SECRET_SNAPSHOT_KEY: '{"identity":"RUNWAY_SECRET_SNAPSHOT_KEY_TEST"}',
              },
            },
          ],
          compatibilityDate: COMPATIBILITY_DATE,
          durableObjects: {
            GITHUB_COORDINATOR_TEST: {
              className: "RunwayGitHubCoordinator",
              scriptName: "generated-github-host",
            },
          },
          bindings: {
            API_KEY: "raw-api-key",
            HOOK_SECRET: "test-secret",
            SANDBOX_SECRET: "raw-sandbox-secret",
            RUNWAY_SECRET_SNAPSHOT_KEY: '{"identity":"RUNWAY_SECRET_SNAPSHOT_KEY_TEST"}',
            RUNWAY_SECRET_SNAPSHOT_KEY_TEST:
              '{"identity":"RUNWAY_SECRET_SNAPSHOT_KEY_TEST","key":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}',
            ACTIVE_ARTIFACT: new TextDecoder().decode(activeArtifact.contents),
            ACTIVE_ARTIFACT_VERSION: activeArtifact.artifactVersion,
            ACTIVE_DEPLOYMENT_ID: generated.deploymentId,
            SUSPENDED_ARTIFACT: new TextDecoder().decode(suspendedArtifact.contents),
            SUSPENDED_ARTIFACT_VERSION: suspendedArtifact.artifactVersion,
            GITHUB_CHECK_ARTIFACT: new TextDecoder().decode(githubCheckArtifact.contents),
            GITHUB_CHECK_ARTIFACT_VERSION: githubCheckArtifact.artifactVersion,
            GITHUB_TEST_ARTIFACT: new TextDecoder().decode(githubTestArtifact.contents),
            GITHUB_TEST_ARTIFACT_VERSION: githubTestArtifact.artifactVersion,
          },
          r2Buckets: { RUNWAY_ARTIFACTS: "runway-test-artifacts" },
          serviceBindings: {
            GITHUB_HOST: {
              name: "generated-github-host",
            },
            GITHUB_MANY_HOST: {
              name: "generated-many-github-host",
            },
            GENERATED_CAPTURE_HOST: {
              name: "generated-runway-capture-host",
            },
            GENERATED_HOST: {
              name: "generated-runway-host",
            },
            GENERATED_ISSUE_HOST: {
              name: "generated-runway-host",
              entrypoint: "RunwaySandboxBinding",
              props: {
                repository: repositoryFixture,
                secretNames: ["HOOK_SECRET", "API_KEY"],
                secretSnapshotKey: "RUNWAY_SECRET_SNAPSHOT_KEY",
                snapshotScope: "generated-runway-host:issue-created:direct-capability",
                terminal: {
                  accountId: "test-account",
                  repositoryId: `remote:${repositoryFixture.remote}`,
                  workflowId: "issue-created",
                  trustId: `remote:${repositoryFixture.remote}`,
                  generation: 1,
                },
              },
            },
            RUNWAY_RUNTIME: {
              name: kCurrentWorker,
              entrypoint: "TestHost",
              props: {
                secrets: {
                  API_KEY: "test-api-key",
                  HOOK_SECRET: "test-secret",
                  SANDBOX_SECRET: "sandbox-secret",
                },
              },
            },
            RUNWAY_TEST_SANDBOX: {
              name: kCurrentWorker,
              entrypoint: "TestSandbox",
            },
            RUNWAY_GITHUB_PROVIDER: {
              name: "github-effects-probe",
              entrypoint: "GitHubProviderProbe",
            },
            RUNWAY_GITHUB_WORKFLOW: {
              name: "github-effects-probe",
              entrypoint: "GitHubWorkflowProbe",
            },
            RUNWAY_GITHUB_CLOCK: {
              name: "github-effects-probe",
              entrypoint: "GitHubClockProbe",
            },
            GENERATED_WORKFLOW_CAPTURE: {
              name: "generated-workflow-capture",
              entrypoint: "TestWorkflowCapture",
            },
          },
          workflows: {
            DAILY: {
              name: "daily-test",
              className: "DailyWorkflow",
            },
            ISSUE_CREATED: {
              name: "issue-created-test",
              className: "IssueCreatedWorkflow",
            },
            COMMANDS: {
              name: "commands-test",
              className: "CommandWorkflow",
            },
            TOOL_COMMANDS: {
              name: "tool-commands-test",
              className: "ToolCommandWorkflow",
            },
            SECRET_SNAPSHOT: {
              name: "secret-snapshot-test",
              className: "SecretSnapshotWorkflow",
            },
            GENERATED_DYNAMIC: {
              name: "generated-workflow-test",
              className: "DynamicWorkflow",
              scriptName: "generated-runway-host",
            },
            REPOSITORY_PROBE_DYNAMIC: {
              name: "repository-probe-workflow-test",
              className: "RepositoryProbeDynamic",
              scriptName: "repository-probe-worker",
            },
            GITHUB_DYNAMIC: {
              name: "generated-github-workflow-test",
              className: "DynamicWorkflow",
              scriptName: "generated-github-host",
            },
          },
        },
      };
    }),
  ],
  test: {
    name: "runway-workers",
    include: ["tests/sandbox.workers.test.ts", "tests/worker.test.ts"],
    testTimeout: 20_000,
  },
});
