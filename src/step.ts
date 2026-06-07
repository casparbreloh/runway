import type { WorkflowStep } from "cloudflare:workers";

import type { Env } from "./env.ts";
import {
  type AgentArgs,
  type AgentResult,
  type ArtifactForkArgs,
  type ArtifactHandle,
  type GitPrArgs,
  type HttpArgs,
  type HttpResult,
  type PrResult,
  runAgent,
  runArtifactFork,
  runGitPr,
  runHttp,
  runSandbox,
  type SandboxArgs,
  type SandboxHandle,
} from "./steps/index.ts";

// The `step` handed to a workflow `run`. It IS the Cloudflare WorkflowStep (so step.do /
// step.sleep / step.waitForEvent stay available) plus Runway's typed primitives. Every
// primitive is a durable `step.do` under the hood; the first arg is its (stable) step name.
export interface RunwayStep extends WorkflowStep {
  readonly artifact: { fork(name: string, args: ArtifactForkArgs): Promise<ArtifactHandle> };
  sandbox(name: string, args: SandboxArgs): Promise<SandboxHandle>;
  agent(name: string, args: AgentArgs): Promise<AgentResult>;
  readonly git: { pr(name: string, args: GitPrArgs): Promise<PrResult> };
  http(name: string, args: HttpArgs): Promise<HttpResult>;
}

// Agent/sandbox/git steps mutate the world and are expensive, so they run once (no retry);
// idempotency comes from the branch being derived from the trigger. http retries by default.
const ONCE = { retries: { limit: 0, delay: "0 seconds" } } as const;

export const makeRunwayStep = (step: WorkflowStep, env: Env): RunwayStep =>
  Object.assign(step, {
    artifact: {
      fork: (name: string, args: ArtifactForkArgs) =>
        step.do(name, () => runArtifactFork(env, args)),
    },
    sandbox: (name: string, args: SandboxArgs) => step.do(name, ONCE, () => runSandbox(env, args)),
    agent: (name: string, args: AgentArgs) => step.do(name, ONCE, () => runAgent(env, args)),
    git: {
      pr: (name: string, args: GitPrArgs) => step.do(name, ONCE, () => runGitPr(env, args)),
    },
    http: (name: string, args: HttpArgs) => step.do(name, () => runHttp(args)),
  });
