import type { ExecResult } from "./types.ts";

export class ExecError extends Error {
  override readonly name = "ExecError";
  readonly id: string;
  readonly command: string;
  readonly result: ExecResult;
  readonly timedOut: boolean;

  constructor(id: string, command: string, result: ExecResult, timedOut: boolean) {
    super(
      timedOut
        ? `command ${JSON.stringify(id)} timed out (exit ${result.exitCode}): ${command}`
        : `command ${JSON.stringify(id)} exited with code ${result.exitCode}: ${command}`,
    );
    this.id = id;
    this.command = command;
    this.result = result;
    this.timedOut = timedOut;
  }
}
