import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

export type Verify = (ctx: {
  readonly raw: string;
  readonly req: Request;
  readonly env: Env;
}) => boolean | Promise<boolean>;

export interface Trigger<T> {
  readonly path: string;
  readonly method: "POST" | "GET";
  readonly verify?: Verify;
  readonly __payload?: T;
}

export interface WorkflowDef<T> {
  readonly id?: string;
  readonly secrets?: readonly string[];
  readonly trigger: Trigger<T>;
  readonly run: (event: WorkflowEvent<T>, step: RunwayStep, env: Env) => Promise<unknown>;
}

export interface SandboxArgs {
  readonly id?: string;
}
export interface SandboxHandle {
  readonly id: string;
}
export interface ShellArgs {
  readonly sandbox: SandboxHandle;
  readonly cmd: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}
export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}
export interface AgentArgs {
  readonly sandbox: SandboxHandle;
  readonly prompt: string;
  readonly apiKey: string;
  readonly cwd?: string;
  readonly model?: string;
}
export interface AgentResult {
  readonly summary: string;
}
export interface HttpArgs {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly body?: string;
}
export interface HttpResult {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
}

export interface RunwayStep extends WorkflowStep {
  sandbox(name: string, args?: SandboxArgs): Promise<SandboxHandle>;
  shell(name: string, args: ShellArgs): Promise<ShellResult>;
  agent(name: string, args: AgentArgs): Promise<AgentResult>;
  http(name: string, args: HttpArgs): Promise<HttpResult>;
}
