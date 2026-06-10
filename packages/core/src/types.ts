export interface StepContext {
  readonly id: string;
}

export interface Ctx<SecretName extends string = never, Params = unknown> {
  readonly runId: string;
  readonly params: Params;
  readonly secrets: Readonly<Record<SecretName, string>>;
  readonly env: unknown;
  step<T>(id: string, fn: (step: StepContext) => T | Promise<T>): Promise<T>;
  sleep(ms: number): Promise<void>;
}

export interface WebhookTimestamp {
  readonly source: "body" | "header";
  readonly field: string;
  readonly toleranceMs: number;
}

export interface WebhookOptions<SecretName extends string = string> {
  readonly path: string;
  readonly secret: SecretName;
  readonly header: string;
  readonly prefix?: string;
  readonly timestamp?: {
    readonly source?: "body" | "header";
    readonly field: string;
    readonly toleranceMs: number;
  };
}

export interface WebhookTrigger<Params = unknown, SecretName extends string = string> {
  readonly type: "webhook";
  readonly path: string;
  readonly secret: SecretName;
  readonly header: string;
  readonly prefix?: string;
  readonly timestamp?: WebhookTimestamp;
  readonly handle?: (body: unknown) => Params | undefined;
}

export interface CronTrigger {
  readonly type: "cron";
  readonly cron: string;
}

export interface CronParams {
  readonly cron: string;
  readonly scheduledTime: number;
}

export type WorkflowTrigger<Params = unknown, SecretName extends string = string> =
  | WebhookTrigger<Params, SecretName>
  | CronTrigger;

export interface WorkflowOptions<SecretName extends string = never> {
  readonly id: string;
  readonly secrets?: ReadonlyArray<SecretName>;
}

export interface WorkflowDefinition {
  readonly __kind: "workflow";
  readonly id: string;
  readonly trigger: WorkflowTrigger;
  readonly secrets: ReadonlyArray<string>;
  readonly handler: (ctx: Ctx<string>) => void | Promise<void>;
}

export interface TriggerBuilder<SecretName extends string = never> {
  trigger(trigger: CronTrigger): WorkflowBuilder<SecretName, CronParams>;
  trigger<Params>(trigger: WebhookTrigger<Params, SecretName>): WorkflowBuilder<SecretName, Params>;
}

export interface WorkflowBuilder<SecretName extends string = never, Params = unknown> {
  handler(fn: (ctx: Ctx<SecretName, Params>) => void | Promise<void>): WorkflowDefinition;
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
  readonly onProgress?: (event: ProgressEvent) => void;
}

export interface DeployResult {
  readonly script: string;
  readonly urls: ReadonlyArray<{ readonly id: string; readonly url: string }>;
}

export interface Backend {
  deploy(registry: Registry, opts: DeployOptions): Promise<DeployResult>;
}

export interface RunwayConfig {
  readonly backend: Backend;
  readonly workflows: ReadonlyArray<string>;
}
