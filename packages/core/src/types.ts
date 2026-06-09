export interface StepContext {
  readonly id: string;
}

export interface Ctx {
  readonly runId: string;
  readonly params: unknown;
  step<T>(id: string, fn: (step: StepContext) => T | Promise<T>): Promise<T>;
  sleep(ms: number): Promise<void>;
}

export type WebhookAuth = {
  readonly type: "raw-hmac-sha256";
  readonly header: string;
  readonly secret: string;
  readonly prefix?: string;
  readonly timestamp?: {
    readonly source: "body" | "header";
    readonly field: string;
    readonly toleranceMs: number;
  };
};

export interface RawHmacSha256WebhookAuthConfig {
  readonly header: string;
  readonly secret: string;
  readonly prefix?: string;
  readonly timestamp?: {
    readonly source?: "body" | "header";
    readonly field: string;
    readonly toleranceMs: number;
  };
}

export type WorkflowTrigger =
  | {
      readonly type: "webhook";
      readonly path: string;
      readonly auth: WebhookAuth;
    }
  | {
      readonly type: "cron";
      readonly cron: string;
    };

export interface WorkflowDefinition {
  readonly __kind: "workflow";
  readonly id: string;
  readonly trigger: WorkflowTrigger;
  readonly handler: (ctx: Ctx) => void | Promise<void>;
}

export interface WorkflowBuilder {
  handler(fn: (ctx: Ctx) => void | Promise<void>): WorkflowDefinition;
}

export interface Primitives {
  step<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, ms: number): Promise<void>;
}

export interface RegisteredWorkflow {
  readonly path: string;
  readonly def: WorkflowDefinition;
}

export type Registry = ReadonlyArray<RegisteredWorkflow>;

export interface ProgressEvent {
  readonly step: "load" | "build" | "deploy";
  readonly status: "start" | "done";
}

export interface DeployOptions {
  readonly cwd: string;
  readonly outDir: string;
  readonly env?: Record<string, string | undefined>;
  onProgress?(event: ProgressEvent): void;
}

export interface DeployResult {
  readonly ok: boolean;
  readonly url?: string;
}

export interface Backend {
  readonly name: string;
  deploy(registry: Registry, opts: DeployOptions): Promise<DeployResult>;
}

export interface RunwayConfig {
  readonly backend: Backend;
  readonly workflows: ReadonlyArray<string>;
}
