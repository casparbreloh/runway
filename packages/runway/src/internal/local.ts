import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Writable } from "node:stream";

import { ExecError, makeStep, type ExecOptions, type ExecResult, type Step } from "../step.ts";
import type { WorkflowDefinition } from "../workflow.ts";

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface LocalRunOptions {
  readonly cwd: string;
  readonly event?: unknown;
  readonly signal?: AbortSignal;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

const tail = (
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> => {
  const combined = Buffer.concat([current, chunk]);
  return combined.subarray(Math.max(0, combined.byteLength - MAX_OUTPUT_BYTES));
};

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted", "AbortError");

const sleep = async (durationMs: number, signal?: AbortSignal): Promise<void> => {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError("sleep durationMs must be a non-negative finite number");
  }
  if (signal?.aborted) throw abortError(signal);
  await new Promise<void>((resolveSleep, reject) => {
    const finish = (error?: unknown): void => {
      signal?.removeEventListener("abort", cancel);
      if (error === undefined) resolveSleep();
      else reject(error);
    };
    const timer = setTimeout(finish, durationMs);
    const cancel = (): void => {
      clearTimeout(timer);
      finish(abortError(signal!));
    };
    signal?.addEventListener("abort", cancel, { once: true });
  });
};

const execute = async (
  id: string,
  command: string | ExecOptions,
  options: LocalRunOptions,
): Promise<ExecResult> => {
  const input = typeof command === "string" ? { command } : command;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("exec timeoutMs must be a positive finite number");
  }
  if (options.signal?.aborted) throw abortError(options.signal);

  const started = Date.now();
  const child = spawn("/bin/sh", ["-c", input.command], {
    cwd: input.cwd ? resolve(options.cwd, input.cwd) : options.cwd,
    env: { ...process.env, CI: "true", ...input.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = tail(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = tail(stderr, chunk);
  });
  if (options.stdout) child.stdout.pipe(options.stdout, { end: false });
  if (options.stderr) child.stderr.pipe(options.stderr, { end: false });

  let timedOut = false;
  let cancelled = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    force ??= setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, 1_000);
  };
  const cancel = (): void => {
    cancelled = true;
    terminate();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);

  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  }).finally(() => {
    clearTimeout(timeout);
    if (force) clearTimeout(force);
    options.signal?.removeEventListener("abort", cancel);
  });

  if (timedOut) {
    const error = new Error(`command timed out after ${timeoutMs}ms`);
    error.name = "ExecTimeoutError";
    throw error;
  }
  if (cancelled) throw abortError(options.signal!);
  const result = {
    exitCode,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    durationMs: Math.max(0, Date.now() - started),
  };
  if (exitCode !== 0) throw new ExecError(id, input.command, result);
  return result;
};

export const runLocal = async (
  definition: WorkflowDefinition,
  options: LocalRunOptions,
): Promise<void> => {
  if (definition.secrets.length > 0) {
    throw new Error("local workflows cannot declare secrets");
  }
  const runId = randomUUID();
  const operations: Pick<Step, "do" | "exec" | "cache" | "sleep"> = {
    do: async (_id, work) => await work(),
    exec: async (id, command) => await execute(id, command, options),
    cache: async () => ({ state: "skipped", reason: "policy" }),
    sleep: async (_id, durationMs) => await sleep(durationMs, options.signal),
  };
  const step = makeStep(operations, { runId, secrets: {} });
  await definition.run(step, options.event);
};
