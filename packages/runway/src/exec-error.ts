import type { ExecResult } from "./step.ts";

const trusted = new WeakSet<ExecError>();

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

export const trustedExecError = (id: string, command: string, result: ExecResult): ExecError => {
  const error = new ExecError(id, command, result);
  trusted.add(error);
  return error;
};

export const isTrustedExecError = (error: unknown): error is ExecError =>
  error instanceof ExecError && trusted.has(error);
