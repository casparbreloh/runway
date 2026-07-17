declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./runtime-worker.ts");
  }

  interface Env {
    DAILY: Workflow;
    ISSUE_CREATED: Workflow;
    COMMANDS: Workflow;
    SECRET_SNAPSHOT: Workflow;
    GENERATED_ISSUE_HOST: {
      terminal(runId: string): Promise<import("../src/terminal.ts").TerminalIdentity>;
      secrets(): Promise<Readonly<Record<string, string>>>;
      captureSecrets(runId: string): Promise<string>;
      restoreSecrets(runId: string, snapshot: string): Promise<Readonly<Record<string, string>>>;
    };
    GENERATED_HOST: Fetcher;
    GENERATED_CAPTURE_HOST: Fetcher;
    GITHUB_HOST: Fetcher;
    GITHUB_MANY_HOST: Fetcher;
    GITHUB_COORDINATOR_TEST: DurableObjectNamespace;
    GENERATED_DYNAMIC: Workflow;
    GITHUB_DYNAMIC: Workflow;
    REPOSITORY_PROBE_DYNAMIC: Workflow;
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
    GITHUB_CHECK_ARTIFACT: string;
    GITHUB_CHECK_ARTIFACT_VERSION: string;
    GITHUB_TEST_ARTIFACT: string;
    GITHUB_TEST_ARTIFACT_VERSION: string;
    RUNWAY_SECRET_SNAPSHOT_KEY: string;
    RUNWAY_TEST_SANDBOX: Service<import("./runtime-worker.ts").TestSandbox>;
    RUNWAY_GITHUB_PROVIDER: Service<import("./runtime-worker.ts").GitHubProviderProbe>;
    RUNWAY_GITHUB_WORKFLOW: Service<import("./runtime-worker.ts").GitHubWorkflowProbe>;
    RUNWAY_GITHUB_CLOCK: Service<import("./runtime-worker.ts").GitHubClockProbe>;
  }
}
