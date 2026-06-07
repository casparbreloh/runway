import { NonRetryableError } from "cloudflare:workflows";

import type { Env } from "../env.ts";
import type { AgentArgs, AgentResult } from "./types.ts";
import { redact, sandboxFor } from "./util.ts";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";
const PROMPT =
  "Read PLAN.md and follow it. If you change files, write a short PR.md summarizing the change.";

// The coding agent. Today it is pi (https://pi.dev) run headless in the sandbox, but the
// workflow only sees "the agent" — the CLI is an implementation detail. Completion is the
// pi JSON `agent_end` event; the summary is the PR.md it leaves behind.
export const runAgent = async (env: Env, args: AgentArgs): Promise<AgentResult> => {
  const sandbox = sandboxFor(env, args.sandbox.id);
  const model = args.model ?? DEFAULT_MODEL;

  await sandbox.setEnvVars({
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
  });
  await sandbox.writeFile(`${args.sandbox.dir}/PLAN.md`, args.prompt);

  const run = await sandbox.exec(
    `cd ${args.sandbox.dir} && pi --model ${model} --mode json -p ${shellQuote(PROMPT)}`,
  );
  if (run.exitCode !== 0 || !agentSucceeded(run.stdout)) {
    throw new NonRetryableError(`agent failed: ${redact(run.stderr || run.stdout)}`);
  }

  const validated = await validate(env, args);
  const summary = (await readSummary(env, args)).trim() || "agent run completed.";
  return { summary, changed: true, ...(validated === undefined ? {} : { validated }) };
};

// pi --mode json streams one JSON object per line; the terminal line is `agent_end`.
const agentSucceeded = (stdout: string): boolean =>
  stdout.split("\n").some((line) => {
    try {
      return (JSON.parse(line) as { type?: string }).type === "agent_end";
    } catch {
      return false;
    }
  });

const readSummary = async (env: Env, args: AgentArgs): Promise<string> => {
  try {
    return (await sandboxFor(env, args.sandbox.id).readFile(`${args.sandbox.dir}/PR.md`)).content;
  } catch {
    return "";
  }
};

const validate = async (env: Env, args: AgentArgs): Promise<boolean | undefined> => {
  const cmds = args.validate ?? [];
  if (cmds.length === 0) return undefined;
  const sandbox = sandboxFor(env, args.sandbox.id);
  for (const cmd of cmds) {
    const v = await sandbox.exec(`cd ${args.sandbox.dir} && ${cmd}`);
    if (v.exitCode !== 0) return false;
  }
  return true;
};

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
