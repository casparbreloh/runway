import type { WorkflowStep } from "cloudflare:workers";

import { runAgent } from "./steps/agent.ts";
import { runHttp } from "./steps/http.ts";
import { runSandbox } from "./steps/sandbox.ts";
import { runShell } from "./steps/shell.ts";
import type {
  AgentArgs,
  AgentResult,
  HttpArgs,
  HttpResult,
  SandboxArgs,
  SandboxHandle,
  ShellArgs,
  ShellResult,
} from "./steps/types.ts";

// The `step` handed to a workflow `run`. It IS the Cloudflare WorkflowStep (so step.do /
// step.sleep / step.waitForEvent stay available — drop down to them, or to any SDK, for
// anything the primitives don't cover) plus Runway's typed primitives. Each primitive is a
// durable step.do; the first arg is its stable step name.
export interface RunwayStep extends WorkflowStep {
  sandbox(name: string, args?: SandboxArgs): Promise<SandboxHandle>;
  shell(name: string, args: ShellArgs): Promise<ShellResult>;
  agent(name: string, args: AgentArgs): Promise<AgentResult>;
  http(name: string, args: HttpArgs): Promise<HttpResult>;
}

// shell + agent mutate the world and are expensive, so they don't auto-retry on application
// errors (the workflow engine can still replay them on infra eviction — keep them idempotent).
const ONCE = { retries: { limit: 0, delay: "0 seconds" } } as const;

export const makeRunwayStep = (step: WorkflowStep, env: Env, instanceId: string): RunwayStep =>
  Object.assign(step, {
    sandbox: (name: string, args: SandboxArgs = {}) =>
      step.do(name, async () => runSandbox(args, instanceId)),
    shell: (name: string, args: ShellArgs) => step.do(name, ONCE, () => runShell(env, args)),
    agent: (name: string, args: AgentArgs) => step.do(name, ONCE, () => runAgent(env, args)),
    http: (name: string, args: HttpArgs) => step.do(name, () => runHttp(args)),
  });
