import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import type {
  AgentArgs,
  AgentResult,
  HttpArgs,
  HttpResult,
  RunwayStep,
  SandboxArgs,
  SandboxHandle,
  ShellArgs,
  ShellResult,
} from "./types.ts";

const SLEEP_AFTER = "1h";
const REDACT = /https:\/\/[^@\s/]+@/g;
const SAFE = /^[A-Za-z0-9._/-]+$/;
const ONCE = { retries: { limit: 0, delay: "0 seconds" } } as const;
const AGENT_MODEL = "anthropic/claude-sonnet-4-5";
const AGENT_INSTRUCTION =
  "Read PLAN.md and implement it. If you change files, write a short PR.md summarizing the change.";

const sandboxFor = (env: Env, id: string): Sandbox =>
  getSandbox(env.Sandbox, id, { sleepAfter: SLEEP_AFTER });
const tail = (s: string): string => (s.length > 4000 ? s.slice(-4000) : s);
const redact = (s: string): string => tail(s).replace(REDACT, "https://***@");
const quote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

const runSandbox = (args: SandboxArgs, instanceId: string): SandboxHandle => ({
  id: args.id ?? `runway-${instanceId}`,
});

const runShell = async (env: Env, args: ShellArgs): Promise<ShellResult> => {
  const result = await sandboxFor(env, args.sandbox.id).exec(args.cmd, {
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(args.env !== undefined ? { env: args.env } : {}),
  });
  return { exitCode: result.exitCode, stdout: tail(result.stdout), stderr: redact(result.stderr) };
};

const runAgent = async (env: Env, args: AgentArgs): Promise<AgentResult> => {
  const sandbox = sandboxFor(env, args.sandbox.id);
  const model = args.model ?? AGENT_MODEL;
  if (!SAFE.test(model)) throw new NonRetryableError(`unsafe model: ${model}`);
  const cwd = args.cwd ?? "/workspace";

  const install = await sandbox.exec(
    "command -v pi >/dev/null 2>&1 || npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
  );
  if (install.exitCode !== 0) {
    throw new NonRetryableError(`agent install failed: ${tail(install.stderr)}`);
  }

  await sandbox.writeFile(`${cwd}/PLAN.md`, args.prompt);
  const run = await sandbox.exec(`pi --model ${model} --mode json -p ${quote(AGENT_INSTRUCTION)}`, {
    cwd,
    env: { ANTHROPIC_API_KEY: args.apiKey, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
  });
  if (run.exitCode !== 0 || !agentEnded(run.stdout)) {
    throw new NonRetryableError(`agent failed: ${redact(run.stderr || run.stdout)}`);
  }

  const pr = await sandbox.readFile(`${cwd}/PR.md`).catch(() => null);
  return { summary: pr?.content.trim() || "agent run completed." };
};

const agentEnded = (stdout: string): boolean =>
  stdout.split("\n").some((line) => {
    try {
      return (JSON.parse(line) as { type?: string }).type === "agent_end";
    } catch {
      return false;
    }
  });

const runHttp = async (args: HttpArgs): Promise<HttpResult> => {
  const headers: Record<string, string> = { ...args.headers };
  let body = args.body;
  if (args.json !== undefined) {
    body = JSON.stringify(args.json);
    headers["content-type"] ??= "application/json";
  }
  const res = await fetch(args.url, {
    method: args.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body === undefined ? {} : { body }),
  });
  return { status: res.status, ok: res.ok, text: await res.text() };
};

export const makeRunwayStep = (step: WorkflowStep, env: Env, instanceId: string): RunwayStep =>
  Object.assign(step, {
    sandbox: (name: string, args: SandboxArgs = {}) =>
      step.do(name, async () => runSandbox(args, instanceId)),
    shell: (name: string, args: ShellArgs) => step.do(name, ONCE, () => runShell(env, args)),
    agent: (name: string, args: AgentArgs) => step.do(name, ONCE, () => runAgent(env, args)),
    http: (name: string, args: HttpArgs) => step.do(name, () => runHttp(args)),
  });
