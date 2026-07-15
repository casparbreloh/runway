declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./runtime-worker.ts");
  }

  interface Env {
    DAILY: Workflow;
    ISSUE_CREATED: Workflow;
    RUNNER: Workflow;
    SECRET_SNAPSHOT: Workflow;
    GENERATED_ISSUE_HOST: {
      secrets(): Promise<Readonly<Record<string, string>>>;
      captureSecrets(runId: string): Promise<string>;
      restoreSecrets(runId: string, snapshot: string): Promise<Readonly<Record<string, string>>>;
    };
    GENERATED_HOST: Fetcher;
    GENERATED_CAPTURE_HOST: Fetcher;
    GENERATED_DYNAMIC: Workflow;
    GENERATED_WORKFLOW_CAPTURE: {
      captured(): Promise<unknown>;
      reset(): Promise<void>;
    };
    RUNWAY_ARTIFACTS: R2Bucket;
    ACTIVE_ARTIFACT: string;
    ACTIVE_ARTIFACT_VERSION: string;
    ACTIVE_DEPLOYMENT_ID: string;
    SUSPENDED_ARTIFACT: string;
    SUSPENDED_ARTIFACT_VERSION: string;
    RUNWAY_SECRET_SNAPSHOT_KEY: string;
    RUNWAY_TEST_RUNNER: Service<import("./runtime-worker.ts").TestRunner>;
  }
}
