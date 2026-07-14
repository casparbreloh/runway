declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./runtime-worker.ts");
  }

  interface Env {
    DAILY: Workflow;
    ISSUE_CREATED: Workflow;
  }
}
