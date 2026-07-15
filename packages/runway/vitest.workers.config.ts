import path from "node:path";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

import { buildDeployment } from "./src/deploy-build.ts";
import { secretRef } from "./src/secrets.ts";
import { cron, webhook } from "./src/trigger.ts";
import type { Registry } from "./src/types.ts";
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
      handler: async () => {},
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
      secrets: ["RUNNER_SECRET"],
      trigger: cron("0 0 * * *"),
    },
  },
];

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const generated = await buildDeployment(generatedHostRegistry, {
        cwd: import.meta.dirname,
        scriptName: "generated-runway-host",
        repository: repositoryFixture,
        snapshotKeyAvailable: true,
      });
      const suspended = await buildDeployment(suspendedRunRegistry, {
        cwd: import.meta.dirname,
        scriptName: "generated-runway-host",
        repository: repositoryFixture,
        snapshotKeyAvailable: true,
      });
      const activeArtifact = generated.artifacts[0]!;
      const suspendedArtifact = suspended.artifacts[0]!;
      return {
        main: "./tests/runtime-worker.ts",
        miniflare: {
          workers: [
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
                RUNNER_SECRET: "runner-secret",
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
                RUNNER_SECRET: "runner-secret",
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
          ],
          compatibilityDate: COMPATIBILITY_DATE,
          bindings: {
            API_KEY: "raw-api-key",
            HOOK_SECRET: "test-secret",
            RUNNER_SECRET: "raw-runner-secret",
            RUNWAY_SECRET_SNAPSHOT_KEY: '{"identity":"RUNWAY_SECRET_SNAPSHOT_KEY_TEST"}',
            RUNWAY_SECRET_SNAPSHOT_KEY_TEST:
              '{"identity":"RUNWAY_SECRET_SNAPSHOT_KEY_TEST","key":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}',
            ACTIVE_ARTIFACT: new TextDecoder().decode(activeArtifact.contents),
            ACTIVE_ARTIFACT_VERSION: activeArtifact.artifactVersion,
            ACTIVE_DEPLOYMENT_ID: generated.deploymentId,
            SUSPENDED_ARTIFACT: new TextDecoder().decode(suspendedArtifact.contents),
            SUSPENDED_ARTIFACT_VERSION: suspendedArtifact.artifactVersion,
          },
          r2Buckets: { RUNWAY_ARTIFACTS: "runway-test-artifacts" },
          serviceBindings: {
            GENERATED_CAPTURE_HOST: {
              name: "generated-runway-capture-host",
            },
            GENERATED_HOST: {
              name: "generated-runway-host",
            },
            GENERATED_ISSUE_HOST: {
              name: "generated-runway-host",
              entrypoint: "RunwayRunnerBinding",
              props: {
                secretNames: ["HOOK_SECRET", "API_KEY"],
                secretSnapshotKey: "RUNWAY_SECRET_SNAPSHOT_KEY",
                snapshotScope: "generated-runway-host:issue-created:direct-capability",
              },
            },
            RUNWAY_HOST: {
              name: kCurrentWorker,
              entrypoint: "TestHost",
              props: {
                secrets: {
                  API_KEY: "test-api-key",
                  HOOK_SECRET: "test-secret",
                  RUNNER_SECRET: "runner-secret",
                },
              },
            },
            RUNWAY_TEST_RUNNER: {
              name: kCurrentWorker,
              entrypoint: "TestRunner",
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
            RUNNER: {
              name: "runner-test",
              className: "RunnerWorkflow",
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
          },
        },
      };
    }),
  ],
  test: {
    name: "runway-workers",
    include: ["tests/runner.test.ts", "tests/worker.test.ts"],
    testTimeout: 20_000,
  },
});
