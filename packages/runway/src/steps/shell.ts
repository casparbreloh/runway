import type { ShellArgs, ShellResult } from "./types.ts";
import { redact, sandboxFor, tail } from "./util.ts";

// Run a command in the sandbox. Secrets belong in `env` (a per-command map that never lands
// in argv), not interpolated into `cmd`. The command itself is yours — quote any untrusted
// data, or (better) pass it through `env` and reference it as $VAR.
export const runShell = async (env: Env, args: ShellArgs): Promise<ShellResult> => {
  const sandbox = sandboxFor(env, args.sandbox.id);
  const result = await sandbox.exec(args.cmd, {
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(args.env !== undefined ? { env: args.env } : {}),
  });
  return {
    exitCode: result.exitCode,
    stdout: tail(result.stdout),
    stderr: redact(result.stderr),
  };
};
