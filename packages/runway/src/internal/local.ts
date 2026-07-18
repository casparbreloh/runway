import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";

import { makeStep, secretsOf, trustedExecError, type ExecResult, type Step } from "../step.ts";
import type { WorkflowDefinition } from "../workflow.ts";
import { LOCAL_SANDBOX_IMAGE } from "./sandbox/config.ts";
import { normalizeExec, type NormalizedExecOptions } from "./sandbox/sandbox.ts";
import { withTools } from "./tool.ts";

interface LocalContainer {
  exec(command: NormalizedExecOptions): Promise<ExecResult>;
  destroy(): Promise<void>;
}

interface LocalRunOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly event: unknown;
  readonly container?: LocalContainer;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
}

export interface LocalRunResult {
  readonly runId: string;
  readonly durationMs: number;
}

const MAX_OUTPUT_BYTES = 64 * 1024;

interface OutputTail {
  readonly chunks: Buffer[];
  bytes: number;
}

const append = (tail: OutputTail, chunk: Buffer): void => {
  tail.chunks.push(chunk);
  tail.bytes += chunk.byteLength;
  while (tail.bytes > MAX_OUTPUT_BYTES && tail.chunks.length > 0) {
    const first = tail.chunks[0]!;
    const excess = tail.bytes - MAX_OUTPUT_BYTES;
    if (first.byteLength <= excess) {
      tail.chunks.shift();
      tail.bytes -= first.byteLength;
    } else {
      tail.chunks[0] = first.subarray(excess);
      tail.bytes -= excess;
    }
  }
};

const run = async (
  executable: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly output?: boolean } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: OutputTail = { chunks: [], bytes: 0 };
    const stderr: OutputTail = { chunks: [], bytes: 0 };
    child.stdout.on("data", (chunk: Buffer) => {
      append(stdout, chunk);
      if (options.output) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append(stderr, chunk);
      if (options.output) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout.chunks).toString("utf8"),
        stderr: Buffer.concat(stderr.chunks).toString("utf8"),
      }),
    );
  });

const dockerContainer = async (cwd: string, now: () => number): Promise<LocalContainer> => {
  const started = await run("docker", [
    "run",
    "--detach",
    "--rm",
    "--platform",
    "linux/amd64",
    "--entrypoint",
    "/bin/sh",
    "--volume",
    `${cwd}:/source:ro`,
    "--workdir",
    "/workspace",
    LOCAL_SANDBOX_IMAGE,
    "-lc",
    "mkdir -p /workspace && tar -C /source --exclude=.git --exclude=node_modules -cf /tmp/source.tar . && tar -C /workspace -xf /tmp/source.tar && rm /tmp/source.tar && sleep infinity",
  ]);
  if (started.code !== 0 || !started.stdout.trim()) {
    throw new Error(started.stderr.trim() || "local Sandbox failed to start");
  }
  const id = started.stdout.trim();
  return {
    exec: async (command) => {
      const workdir = posix.resolve("/workspace", command.cwd);
      const args = ["exec", "--workdir", workdir];
      for (const [name, value] of Object.entries(command.env)) {
        args.push("--env", `${name}=${value}`);
      }
      args.push(
        id,
        "timeout",
        "--signal=TERM",
        "--kill-after=5s",
        `${command.timeoutMs / 1000}s`,
        "/bin/sh",
        "-lc",
        command.command,
      );
      const before = now();
      const result = await run("docker", args, { output: true });
      return {
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Math.max(0, Math.round(now() - before)),
      };
    },
    destroy: async () => {
      await run("docker", ["rm", "--force", id]);
    },
  };
};

export const runLocal = async (
  definition: WorkflowDefinition,
  options: LocalRunOptions,
): Promise<LocalRunResult> => {
  const now = options.now ?? (() => performance.now());
  const wait =
    options.wait ??
    (async (durationMs: number) =>
      await new Promise<void>((resolve) => setTimeout(resolve, durationMs)));
  const started = now();
  const runId = `local-${randomUUID()}`;
  const container = options.container ?? (await dockerContainer(options.cwd, now));
  const operations: Pick<Step, "do" | "exec" | "cache" | "sleep"> = {
    do: async (_id, work) => await work(),
    exec: async (id, command) => {
      const normalized = typeof command === "string" ? command : command.command;
      const result = await container.exec(normalizeExec(command));
      if (result.exitCode !== 0) throw trustedExecError(id, normalized, result);
      return result;
    },
    cache: async () => ({ state: "skipped", reason: "policy" }),
    sleep: async (_id, durationMs) => await wait(durationMs),
  };
  try {
    await definition.run(
      makeStep(
        { ...operations, ...withTools(operations, definition.tools) },
        {
          runId,
          secrets: secretsOf(definition.secrets, options.env),
        },
      ),
      options.event,
    );
    return { runId, durationMs: Math.max(0, Math.round(now() - started)) };
  } finally {
    await container.destroy();
  }
};
