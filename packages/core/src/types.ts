export interface StepContext {
  readonly id: string;
}

export interface Ctx {
  readonly runId: string;
  step<T>(id: string, fn: (step: StepContext) => T | Promise<T>): Promise<T>;
  sleep(ms: number): Promise<void>;
}

export interface WorkflowDefinition {
  readonly __kind: "workflow";
  readonly id: string;
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

export interface BuildOptions {
  readonly cwd: string;
  readonly outDir: string;
}

export interface BuildResult {
  readonly entry: string;
}

export interface DeployOptions extends BuildOptions {
  readonly env?: Record<string, string | undefined>;
}

export interface DeployResult {
  readonly ok: boolean;
  readonly url?: string;
}

export interface Backend {
  readonly name: string;
  build(registry: Registry, opts: BuildOptions): Promise<BuildResult>;
  deploy(registry: Registry, opts: DeployOptions): Promise<DeployResult>;
}

export interface RunwayConfig {
  readonly backend: Backend;
  readonly workflows: ReadonlyArray<string>;
}
