import type { ExecResult } from "./types.ts";

export class ExecError extends Error {
  override readonly name = "ExecError";
  readonly id: string;
  readonly command: string;
  readonly result: ExecResult;

  constructor(id: string, command: string, result: ExecResult) {
    super(`command ${JSON.stringify(id)} exited with code ${result.exitCode}: ${command}`);
    this.id = id;
    this.command = command;
    this.result = result;
  }
}
