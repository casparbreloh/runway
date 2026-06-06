// Type-only import: erased at build time so this module (and the RecordingRunner fake it
// exports) loads under plain Node for dry-runs/tests. The one value import — getSandbox — lives
// in the Worker entry (src/index.ts), which runs under workerd where `cloudflare:workers` resolves.
import type { Sandbox } from '@cloudflare/sandbox';

/** Normalized result of one command, independent of the underlying runtime. */
export interface ExecResult {
  command: string;
  exitCode: number;
  success: boolean;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Milliseconds. */
  timeout?: number;
}

/**
 * The minimal command-runner surface Runway executors depend on.
 * Injected (not constructed inside executors) so dry-runs and unit tests use a fake.
 */
export interface SandboxRunner {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  writeFile(path: string, content: string): Promise<void>;
  setEnvVars(env: Record<string, string>): Promise<void>;
  destroy(): Promise<void>;
}

/** Wraps a Cloudflare Sandbox stub as a SandboxRunner. */
export class CloudflareSandboxRunner implements SandboxRunner {
  constructor(private readonly sandbox: Sandbox) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const r = await this.sandbox.exec(command, options);
    return {
      command: r.command,
      exitCode: r.exitCode,
      success: r.success,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sandbox.writeFile(path, content);
  }

  async setEnvVars(env: Record<string, string>): Promise<void> {
    await this.sandbox.setEnvVars(env);
  }

  async destroy(): Promise<void> {
    await this.sandbox.destroy();
  }
}

/**
 * In-memory fake for dry-runs and tests. Records every command/write/env and returns
 * canned results from an optional responder (default: exit 0, empty output).
 */
export class RecordingRunner implements SandboxRunner {
  readonly commands: string[] = [];
  readonly writes: Array<{ path: string; content: string }> = [];
  readonly envVars: Record<string, string> = {};
  destroyed = false;

  constructor(private readonly responder: (command: string) => Partial<ExecResult> = () => ({})) {}

  async exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    const r = this.responder(command);
    const exitCode = r.exitCode ?? 0;
    return {
      command,
      exitCode,
      success: r.success ?? exitCode === 0,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.writes.push({ path, content });
  }

  async setEnvVars(env: Record<string, string>): Promise<void> {
    Object.assign(this.envVars, env);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}
