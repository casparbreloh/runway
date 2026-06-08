import { NonRetryableError } from "cloudflare:workflows";

import type { AgentArgs, AgentResult } from "./types.ts";
import { assertSafe, redact, sandboxFor, shellQuote, tail } from "./util.ts";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";
const INSTRUCTION =
  "Read PLAN.md and implement it. If you change files, write a short PR.md summarizing the change.";

// The coding agent. Today it's pi (https://pi.dev) run headless in the sandbox — installed on
// first use so no custom image is needed — but the workflow only sees "the agent". The model
// key is passed via env, never argv; completion is pi's JSON `agent_end` event.
export const runAgent = async (env: Env, args: AgentArgs): Promise<AgentResult> => {
  const sandbox = sandboxFor(env, args.sandbox.id);
  const model = args.model ?? DEFAULT_MODEL;
  assertSafe(model);
  const cwd = args.cwd ?? "/workspace";

  const install = await sandbox.exec(
    "command -v pi >/dev/null 2>&1 || npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
  );
  if (install.exitCode !== 0) {
    throw new NonRetryableError(`agent install failed: ${tail(install.stderr)}`);
  }

  await sandbox.writeFile(`${cwd}/PLAN.md`, args.prompt);
  const run = await sandbox.exec(`pi --model ${model} --mode json -p ${shellQuote(INSTRUCTION)}`, {
    cwd,
    env: { ANTHROPIC_API_KEY: args.apiKey, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
  });
  if (run.exitCode !== 0 || !agentSucceeded(run.stdout)) {
    throw new NonRetryableError(`agent failed: ${redact(run.stderr || run.stdout)}`);
  }

  return { summary: (await readPrMd(sandbox, cwd)).trim() || "agent run completed." };
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

const readPrMd = async (sandbox: ReturnType<typeof sandboxFor>, cwd: string): Promise<string> => {
  try {
    return (await sandbox.readFile(`${cwd}/PR.md`)).content;
  } catch {
    return "";
  }
};
