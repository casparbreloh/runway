import { redactError, StreamingRedactor } from "../../secret-redaction.ts";
import type { ExecResult } from "../../step.ts";
import type { CacheSnapshotProcess } from "../cache/cloudflare-snapshot.ts";
import type {
  CacheTransferCapability,
  CacheTransferSession,
} from "../cache/cloudflare-transfer.ts";
import type { GitHubRepositoryAuthentication, RepositorySource } from "../source/repository.ts";
import type { PreparedSource } from "../source/source.ts";
import {
  digestCommand,
  ExecTimeoutError,
  RunLostError,
  type NormalizedExecOptions,
} from "./sandbox.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const REPOSITORY_CHECKOUT_TIMEOUT_MS = 5 * 60_000;
const REPOSITORY_GENERATION = "/tmp/runway-checkout-generation";
const REPOSITORY_MARKER = "/tmp/runway-repository";
const REPOSITORY_METRICS = "/tmp/runway-repository-metrics";
const REPOSITORY_GIT_DIRECTORY = "/workspace/.git";
const REPOSITORY_ASKPASS = "/tmp/runway-git-askpass";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const processEvents = async function* <T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader();
  const streamDecoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? streamDecoder.decode() : streamDecoder.decode(value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield JSON.parse(data) as T;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
};

export interface SandboxCommand {
  readonly runId: string;
  readonly step: { readonly id: string; readonly count: number; readonly attempt: number };
  readonly options: NormalizedExecOptions;
  readonly secrets: ReadonlyArray<string>;
  readonly source: PreparedSource;
}

export interface CloudflareSandbox {
  prepare(request: {
    readonly runId: string;
    readonly secrets: ReadonlyArray<string>;
    readonly allowReconstruct: boolean;
  }): Promise<PreparedSource>;
  execute(request: SandboxCommand): Promise<ExecResult>;
  inspectCacheFile(request: {
    readonly runId: string;
    readonly source: PreparedSource;
    readonly path: string;
    readonly secrets: ReadonlyArray<string>;
  }): Promise<
    | { readonly type: "file"; readonly bytes: Uint8Array }
    | { readonly type: "missing" }
    | { readonly type: "symlink" }
    | { readonly type: "directory" }
  >;
  quiesce(runId: string, secrets: ReadonlyArray<string>): Promise<void>;
  cacheProcess(runId: string, secrets: ReadonlyArray<string>): Promise<CacheSnapshotProcess>;
  cacheTransfer(
    runId: string,
    secrets: ReadonlyArray<string>,
  ): { quiesce(): Promise<CacheTransferSession> };
  destroy(runId: string, secrets: ReadonlyArray<string>): Promise<void>;
}

interface SandboxProcess {
  readonly id: string;
  readonly command: string;
  readonly status: string;
  readonly startTime: Date;
  readonly endTime?: Date | undefined;
  readonly exitCode?: number | undefined;
}

interface PlatformSandbox {
  exists(path: string): Promise<{ readonly exists: boolean }>;
  readFile(path: string): Promise<{ readonly success: boolean; readonly content: string }>;
  readFileStream?(path: string): Promise<ReadableStream<Uint8Array>>;
  listFiles?(
    path: string,
    options?: { readonly recursive?: boolean; readonly includeHidden?: boolean },
  ): Promise<{
    readonly success: boolean;
    readonly files: ReadonlyArray<{
      readonly absolutePath: string;
      readonly type: "file" | "directory" | "symlink" | "other";
    }>;
  }>;
  getProcess(id: string): Promise<SandboxProcess | null>;
  startProcess(
    command: string,
    options: {
      processId: string;
      autoCleanup: false;
      cwd: string;
      env: Record<string, string>;
    },
  ): Promise<SandboxProcess>;
  streamProcessLogs(id: string): Promise<ReadableStream<Uint8Array>>;
  killProcess(id: string, signal?: string): Promise<void>;
  killAllProcesses(): Promise<unknown>;
  createSession?(options: { readonly cwd: string }): Promise<InternalSession>;
  deleteSession?(id: string): Promise<{ readonly success: boolean }>;
  destroy(): Promise<unknown>;
}

interface InternalSession {
  readonly id: string;
  exec(
    command: string,
    options: { readonly origin: "internal"; readonly timeout: number },
  ): Promise<{ readonly success: boolean; readonly stdout: string }>;
  writeFile(path: string, contents: string): Promise<{ readonly success: boolean }>;
  deleteFile(path: string): Promise<{ readonly success: boolean }>;
  renameFile(from: string, to: string): Promise<{ readonly success: boolean }>;
  killAllProcesses(): Promise<unknown>;
}

interface SandboxLog {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly stream: "stdout" | "stderr";
  readonly chunk: string;
}

interface ProcessLogEvent {
  readonly type: "stdout" | "stderr" | "exit" | "complete" | "error";
  readonly data?: string;
  readonly exitCode?: number;
}

type OutputStream = "stdout" | "stderr";

const outputStreams: Partial<Record<ProcessLogEvent["type"], OutputStream>> = {
  stdout: "stdout",
  stderr: "stderr",
};

interface OutputCollector {
  push(stream: OutputStream, chunk: string): void;
  flush(): void;
  result(): Pick<ExecResult, "stdout" | "stderr">;
}

interface CloudflareSandboxOptions {
  readonly placement: (sandboxId: string) => PlatformSandbox | Promise<PlatformSandbox>;
  readonly repository: RepositorySource;
  readonly installationToken?: (request: {
    readonly purpose: "checkout";
    readonly authentication: GitHubRepositoryAuthentication;
  }) => Promise<string>;
  readonly log: (entry: SandboxLog) => void;
  readonly status?: (runId: string) => Promise<{ status: string }>;
  readonly waitUntil?: (promise: Promise<void>) => void;
}

const hashId = async (prefix: string, parts: ReadonlyArray<string | number>): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.map(String).join("\0")),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}-${hash.slice(0, 32)}`;
};

const appendTail = (tail: string, chunk: string): string => {
  const bytes = encoder.encode(`${tail}${chunk}`);
  if (bytes.byteLength <= MAX_OUTPUT_BYTES) return decoder.decode(bytes);
  let start = bytes.byteLength - MAX_OUTPUT_BYTES;
  while ((bytes[start]! & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
};

const isTerminal = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "killed" || status === "error";

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const managedCommand = (command: string, digest?: string): string =>
  `${digest ? `: ${digest}; ` : ""}child=; cleanup() { [ -z "$child" ] || kill -KILL -- -"$child" 2>/dev/null || true; }; trap cleanup EXIT; trap 'exit 143' TERM INT HUP; setsid sh -c ${shellQuote(command)} & child=$!; wait "$child"`;

const repositoryMarker = (repository: RepositorySource, placement: string): string =>
  JSON.stringify({ repository, placement });

const askpassHelper = `#!/bin/sh
case "$1" in
  "Username for 'https://github.com': ") printf '%s\\n' 'x-access-token' ;;
  "Password for 'https://x-access-token@github.com': ") printf '%s\\n' "$RUNWAY_GITHUB_TOKEN" ;;
  *) exit 1 ;;
esac`;

const checkoutCommand = (
  repository: RepositorySource,
  generation: number,
  placement: string,
): string => {
  const remote = shellQuote(repository.remote);
  const commit = shellQuote(repository.commit);
  const marker = shellQuote(repositoryMarker(repository, placement));
  const helper = shellQuote(askpassHelper);
  return `set -eu; helper="${"${GIT_ASKPASS:-}"}"; cleanup_checkout() { [ -z "$helper" ] || rm -f "$helper"; }; trap cleanup_checkout EXIT; if [ -n "${"${RUNWAY_GITHUB_TOKEN:-}"}" ]; then umask 077; printf %s ${helper} > "$helper"; chmod 700 "$helper"; fi; started_at=$(date +%s%3N); rm -rf /workspace; mkdir -p /workspace; git init -q /workspace; git -C /workspace remote add origin ${remote}; fetch_started_at=$(date +%s%3N); git -c http.followRedirects=false -C /workspace fetch --quiet --depth=1 --filter=blob:none origin ${commit}; fetch_completed_at=$(date +%s%3N); git -C /workspace checkout --quiet --detach FETCH_HEAD; test "$(git -C /workspace rev-parse HEAD)" = ${commit}; completed_at=$(date +%s%3N); pack_bytes=$(find /workspace/.git/objects/pack -type f -name '*.pack' -exec wc -c {} + | awk '{ total += $1 } END { print total + 0 }'); printf '{"commit":"%s","generation":%s,"authenticationTokenMinted":%s,"prepareStartedAtMs":%s,"sandboxReadyAtMs":%s,"startedAtMs":%s,"fetchMs":%s,"checkoutMs":%s,"packBytes":%s}' ${commit} ${generation} "$RUNWAY_AUTHENTICATION_TOKEN_MINTED" "$RUNWAY_PREPARE_STARTED_AT_MS" "$RUNWAY_SANDBOX_READY_AT_MS" "$started_at" "$((fetch_completed_at - fetch_started_at))" "$((completed_at - started_at))" "$pack_bytes" > ${REPOSITORY_METRICS}; printf %s ${marker} > ${REPOSITORY_MARKER}; printf %s ${generation} > ${REPOSITORY_GENERATION}`;
};

const killProcessGroup = async (
  sandbox: PlatformSandbox,
  process: SandboxProcess,
): Promise<void> => {
  await sandbox.killProcess(process.id);
};

const cancellableDelay = (durationMs: number): { promise: Promise<void>; cancel(): void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    promise: new Promise((resolve) => {
      timer = setTimeout(resolve, durationMs);
    }),
    cancel: () => clearTimeout(timer),
  };
};

const watchTermination = async (
  request: SandboxCommand,
  sandbox: PlatformSandbox,
  process: SandboxProcess,
  status: NonNullable<CloudflareSandboxOptions["status"]>,
  completed: () => boolean,
  untilCompleted: Promise<void>,
): Promise<void> => {
  while (!completed()) {
    const delay = cancellableDelay(1000);
    await Promise.race([delay.promise, untilCompleted]);
    delay.cancel();
    if (completed()) return;
    const current = await status(request.runId).catch(() => undefined);
    if (completed()) return;
    if (current?.status === "terminated") {
      try {
        await killProcessGroup(sandbox, process);
      } finally {
        await sandbox.destroy();
      }
      return;
    }
  }
};

const lost = (message: string): RunLostError =>
  new RunLostError(`run continuity was lost: ${message}`);

const redactFailure = (error: unknown, secrets: ReadonlyArray<string>): Error => {
  const redacted = redactError(error, secrets);
  if (error instanceof RunLostError) return new RunLostError(redacted.message);
  if (error instanceof ExecTimeoutError) return new ExecTimeoutError(redacted.message);
  return redacted;
};

const createOutputCollector = (
  request: SandboxCommand,
  log: CloudflareSandboxOptions["log"],
): OutputCollector => {
  const redactors = {
    stdout: new StreamingRedactor(request.secrets),
    stderr: new StreamingRedactor(request.secrets),
  };
  let stdout = "";
  let stderr = "";
  const write = (stream: "stdout" | "stderr", chunk: string): void => {
    if (!chunk) return;
    log({
      runId: request.runId,
      stepId: request.step.id,
      attempt: request.step.attempt,
      stream,
      chunk,
    });
    if (stream === "stdout") stdout = appendTail(stdout, chunk);
    else stderr = appendTail(stderr, chunk);
  };
  return {
    push: (stream, chunk) => write(stream, redactors[stream].push(chunk)),
    flush: () => {
      write("stdout", redactors.stdout.flush());
      write("stderr", redactors.stderr.flush());
    },
    result: () => ({ stdout, stderr }),
  };
};

const handleProcessEvent = (
  event: ProcessLogEvent,
  output: OutputCollector,
  exitCode: number | undefined,
): number | undefined => {
  const stream = outputStreams[event.type];
  if (stream) {
    output.push(stream, eventData(event, ""));
    return exitCode;
  }
  if (event.type === "error") throw new Error(eventData(event, "process log stream failed"));
  return streamExitCode(event.exitCode, exitCode);
};

const eventData = (event: ProcessLogEvent, fallback: string): string =>
  event.data === undefined ? fallback : event.data;

const streamExitCode = (
  eventExitCode: number | undefined,
  exitCode: number | undefined,
): number => {
  if (eventExitCode !== undefined) return eventExitCode;
  return exitCode === undefined ? 1 : exitCode;
};

const resolveExitCode = async (
  sandbox: PlatformSandbox,
  process: SandboxProcess,
  exitCode: number | undefined,
): Promise<number> => {
  if (exitCode !== undefined) return exitCode;
  const refreshed = await sandbox.getProcess(process.id);
  if (refreshed?.exitCode === undefined)
    throw new Error(`process ${process.id} ended without an exit code`);
  return refreshed.exitCode;
};

const collectResult = async (
  sandbox: PlatformSandbox,
  process: SandboxProcess,
  request: SandboxCommand,
  log: CloudflareSandboxOptions["log"],
): Promise<ExecResult> => {
  const output = createOutputCollector(request, log);
  let exitCode = process.exitCode;
  const stream = await sandbox.streamProcessLogs(process.id);
  for await (const event of processEvents<ProcessLogEvent>(stream))
    exitCode = handleProcessEvent(event, output, exitCode);
  output.flush();
  const endTime = process.endTime?.getTime() ?? Date.now();
  return {
    exitCode: await resolveExitCode(sandbox, process, exitCode),
    ...output.result(),
    durationMs: Math.max(0, endTime - process.startTime.getTime()),
  };
};

const collectRecoveredCheckoutResult = async (
  sandbox: PlatformSandbox,
  process: SandboxProcess,
): Promise<ExecResult> => {
  try {
    let exitCode = process.exitCode;
    const stream = await sandbox.streamProcessLogs(process.id);
    for await (const event of processEvents<ProcessLogEvent>(stream)) {
      if (event.type === "error") throw new Error("repository checkout recovery failed");
      if (event.type === "exit" || event.type === "complete") {
        exitCode = streamExitCode(event.exitCode, exitCode);
      }
    }
    const endTime = process.endTime?.getTime() ?? Date.now();
    return {
      exitCode: await resolveExitCode(sandbox, process, exitCode),
      stdout: "",
      stderr: "",
      durationMs: Math.max(0, endTime - process.startTime.getTime()),
    };
  } catch {
    throw new Error("repository checkout recovery failed");
  }
};

const checkoutGeneration = async (sandbox: PlatformSandbox): Promise<number> => {
  const exists = await sandbox.exists(REPOSITORY_GENERATION);
  if (!exists.exists) return 0;
  const stored = await sandbox.readFile(REPOSITORY_GENERATION);
  if (!stored.success || !/^\d+$/.test(stored.content)) return 0;
  return Number(stored.content);
};

const checkoutBytes = async (sandbox: PlatformSandbox): Promise<number> => {
  const stored = await sandbox.readFile(REPOSITORY_METRICS);
  if (!stored.success) throw new Error("repository checkout metrics are invalid");
  let metrics: unknown;
  try {
    metrics = JSON.parse(stored.content);
  } catch {
    throw new Error("repository checkout metrics are invalid");
  }
  const bytes =
    metrics && typeof metrics === "object" && !Array.isArray(metrics)
      ? (metrics as Record<string, unknown>).packBytes
      : undefined;
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error("repository checkout metrics are invalid");
  }
  return bytes;
};

const prepareRepository = async (
  sandbox: PlatformSandbox,
  request: SandboxCommand,
  repository: RepositorySource,
  allowReconstruct: boolean,
  installationToken: CloudflareSandboxOptions["installationToken"],
  log: CloudflareSandboxOptions["log"],
): Promise<PreparedSource> => {
  const prepareStartedAtMs = Date.now();
  const marker = await sandbox.exists(REPOSITORY_MARKER);
  const sandboxReadyAtMs = Date.now();
  if (marker.exists) {
    const stored = await sandbox.readFile(REPOSITORY_MARKER);
    const checkout = await sandbox.exists(REPOSITORY_GIT_DIRECTORY);
    if (stored.success && checkout.exists) {
      try {
        const evidence = JSON.parse(stored.content) as Record<string, unknown>;
        if (
          Object.keys(evidence).sort().join(",") === "placement,repository" &&
          JSON.stringify(evidence.repository) === JSON.stringify(repository) &&
          typeof evidence.placement === "string" &&
          evidence.placement.length >= 16
        ) {
          return {
            placement: evidence.placement,
            result: { revision: repository.commit, state: "reused", bytes: 0 },
          };
        }
      } catch {}
    }
  }
  if (!allowReconstruct) throw lost("the command placement was replaced");
  const checkoutRequest: SandboxCommand = {
    ...request,
    step: { ...request.step, id: "runway:checkout" },
  };
  const generation = (await checkoutGeneration(sandbox)) + 1;
  const placement = crypto.randomUUID();
  const processId = await hashId("checkout", [request.runId, generation]);
  const command = managedCommand(checkoutCommand(repository, generation, placement));
  let process = await sandbox.getProcess(processId);
  let token: string | undefined;
  let ownsAuthenticatedCheckout = false;
  if (!process) {
    try {
      const env: Record<string, string> = {
        CI: "true",
        RUNWAY_AUTHENTICATION_TOKEN_MINTED: "false",
        RUNWAY_PREPARE_STARTED_AT_MS: String(prepareStartedAtMs),
        RUNWAY_SANDBOX_READY_AT_MS: String(sandboxReadyAtMs),
      };
      if (repository.authentication.type === "github") {
        if (!installationToken) throw new Error("missing GitHub repository authentication");
        token = await installationToken({
          purpose: "checkout",
          authentication: repository.authentication,
        });
        if (!token) throw new Error("missing GitHub repository authentication");
        env.GIT_ASKPASS = REPOSITORY_ASKPASS;
        env.GIT_TERMINAL_PROMPT = "0";
        env.RUNWAY_AUTHENTICATION_TOKEN_MINTED = "true";
        env.RUNWAY_GITHUB_TOKEN = token;
      }
      process = await sandbox.startProcess(command, {
        processId,
        autoCleanup: false,
        cwd: "/",
        env,
      });
      ownsAuthenticatedCheckout = repository.authentication.type === "github";
    } catch (error) {
      process = await sandbox.getProcess(processId);
      if (!process) throw redactError(error, [...request.secrets, ...(token ? [token] : [])]);
    }
  }
  if (process.command !== command) throw new Error("repository checkout process collision");
  const timeout = cancellableDelay(REPOSITORY_CHECKOUT_TIMEOUT_MS);
  const redactedCheckoutRequest = {
    ...checkoutRequest,
    secrets: [...checkoutRequest.secrets, ...(token ? [token] : [])],
  };
  const recoveredAuthenticatedCheckout =
    repository.authentication.type === "github" && !ownsAuthenticatedCheckout;
  try {
    const result = await Promise.race([
      recoveredAuthenticatedCheckout
        ? collectRecoveredCheckoutResult(sandbox, process)
        : collectResult(sandbox, process, redactedCheckoutRequest, log),
      timeout.promise.then(async () => {
        await killProcessGroup(sandbox, process);
        await sandbox.destroy();
        throw new Error(`repository checkout timed out after ${REPOSITORY_CHECKOUT_TIMEOUT_MS}ms`);
      }),
    ]);
    if (result.exitCode !== 0) {
      await sandbox.destroy();
      throw new Error(`repository checkout failed with code ${result.exitCode}: ${result.stderr}`);
    }
    const prepared = await sandbox.readFile(REPOSITORY_MARKER);
    const checkout = await sandbox.exists(REPOSITORY_GIT_DIRECTORY);
    if (
      !prepared.success ||
      prepared.content !== repositoryMarker(repository, placement) ||
      !checkout.exists
    ) {
      await sandbox.destroy();
      throw new Error("repository checkout did not prepare the expected source");
    }
    let bytes: number;
    try {
      bytes = await checkoutBytes(sandbox);
    } catch (error) {
      await sandbox.destroy();
      throw error;
    }
    return {
      placement,
      result: { revision: repository.commit, state: "prepared", bytes },
    };
  } catch (error) {
    if (recoveredAuthenticatedCheckout) throw new Error("repository checkout recovery failed");
    throw redactFailure(error, redactedCheckoutRequest.secrets);
  } finally {
    timeout.cancel();
  }
};

export const cloudflareSandbox = (options: CloudflareSandboxOptions): CloudflareSandbox => {
  const prepare: CloudflareSandbox["prepare"] = async (request) => {
    try {
      const sandboxId = await hashId("runway", [request.runId]);
      const sandbox = await options.placement(sandboxId);
      return await prepareRepository(
        sandbox,
        {
          runId: request.runId,
          step: { id: "runway:checkout", count: 1, attempt: 1 },
          options: { command: "true", cwd: "/", env: { CI: "true" }, timeoutMs: 1 },
          secrets: request.secrets,
          source: {
            placement: "source-preparation",
            result: { revision: options.repository.commit, state: "prepared", bytes: 0 },
          },
        },
        options.repository,
        request.allowReconstruct,
        options.installationToken,
        options.log,
      );
    } catch (error) {
      throw redactFailure(error, request.secrets);
    }
  };
  const execute: CloudflareSandbox["execute"] = async (request): Promise<ExecResult> => {
    let completed = false;
    let finish = (): void => {};
    const untilCompleted = new Promise<void>((resolve) => (finish = resolve));
    try {
      const sandboxId = await hashId("runway", [request.runId]);
      const digest = await digestCommand(request.options);
      const processId = await hashId("step", [
        request.runId,
        request.step.id,
        request.step.count,
        digest,
      ]);
      const command = managedCommand(request.options.command, digest);
      const sandbox = await options.placement(sandboxId);
      if (request.source.result.revision !== options.repository.commit) {
        throw new Error("command source does not match the exact repository revision");
      }
      const marker = await sandbox.exists(REPOSITORY_MARKER);
      const storedMarker = marker.exists ? await sandbox.readFile(REPOSITORY_MARKER) : undefined;
      const checkout = await sandbox.exists(REPOSITORY_GIT_DIRECTORY);
      if (
        !storedMarker?.success ||
        storedMarker.content !== repositoryMarker(options.repository, request.source.placement) ||
        !checkout.exists
      ) {
        throw lost("the command placement was replaced");
      }
      let process = await sandbox.getProcess(processId);
      if (!process) {
        if (request.step.attempt > 1) throw lost("the command process disappeared during retry");
        try {
          process = await sandbox.startProcess(command, {
            processId,
            autoCleanup: false,
            cwd: request.options.cwd,
            env: { ...request.options.env },
          });
        } catch {
          process = await sandbox.getProcess(processId);
          if (!process) throw lost("the command start response was ambiguous");
        }
      }
      if (process.command !== command) {
        throw lost(`the command evidence changed for step ${JSON.stringify(request.step.id)}`);
      }
      if (process.status === "killed" || process.status === "error") {
        throw lost("the command was cancelled or its result is ambiguous");
      }
      if (isTerminal(process.status)) {
        return await collectResult(sandbox, process, request, options.log).catch(() => {
          throw lost("the recorded command result is ambiguous");
        });
      }
      if (options.status && options.waitUntil) {
        options.waitUntil(
          watchTermination(
            request,
            sandbox,
            process,
            options.status,
            () => completed,
            untilCompleted,
          ).catch((error) => {
            throw redactFailure(error, request.secrets);
          }),
        );
      }
      const elapsedMs = Math.max(0, Date.now() - process.startTime.getTime());
      const remainingMs = Math.max(0, request.options.timeoutMs - elapsedMs);
      const timeout = cancellableDelay(remainingMs);
      try {
        const result = await Promise.race([
          collectResult(sandbox, process, request, options.log).catch(() => {
            throw lost("the command result is ambiguous");
          }),
          timeout.promise.then(async () => {
            await killProcessGroup(sandbox, process);
            throw new ExecTimeoutError(`command timed out after ${request.options.timeoutMs}ms`);
          }),
        ]);
        return result;
      } finally {
        timeout.cancel();
      }
    } catch (error) {
      throw redactFailure(error, request.secrets);
    } finally {
      completed = true;
      finish();
    }
  };
  const inspectCacheFile: CloudflareSandbox["inspectCacheFile"] = async (request) => {
    try {
      if (request.source.result.revision !== options.repository.commit) {
        throw new Error("cache source does not match the exact repository revision");
      }
      const sandbox = await options.placement(await hashId("runway", [request.runId]));
      const storedMarker = await sandbox.readFile(REPOSITORY_MARKER);
      const checkout = await sandbox.exists(REPOSITORY_GIT_DIRECTORY);
      if (
        !storedMarker.success ||
        storedMarker.content !== repositoryMarker(options.repository, request.source.placement) ||
        !checkout.exists
      ) {
        throw lost("the cache placement was replaced");
      }
      const absolute = `/workspace/${request.path}`;
      const slash = absolute.lastIndexOf("/");
      const parent = absolute.slice(0, slash) || "/workspace";
      if (!sandbox.listFiles || !sandbox.readFileStream) {
        throw new Error("cache source inspection is unavailable");
      }
      const listed = await sandbox.listFiles(parent, { recursive: false, includeHidden: true });
      if (!listed.success) return { type: "missing" };
      const entry = listed.files.find((candidate) => candidate.absolutePath === absolute);
      if (!entry) return { type: "missing" };
      if (entry.type === "directory") return { type: "directory" };
      if (entry.type !== "file") return { type: "symlink" };
      const reader = (await sandbox.readFileStream(absolute)).getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          length += value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { type: "file", bytes };
    } catch (error) {
      throw redactFailure(error, request.secrets);
    }
  };
  const internalSession = async (
    runId: string,
  ): Promise<{
    readonly sandbox: PlatformSandbox;
    readonly session: InternalSession;
  }> => {
    const sandbox = await options.placement(await hashId("runway", [runId]));
    if (!sandbox.createSession || !sandbox.deleteSession) {
      throw new Error("cache snapshot process is unavailable");
    }
    return { sandbox, session: await sandbox.createSession({ cwd: "/" }) };
  };
  const internal = async (
    session: InternalSession,
    command: string,
    timeout = 5 * 60_000,
  ): Promise<string> => {
    const result = await session.exec(command, {
      origin: "internal",
      timeout,
    });
    if (!result.success) throw new Error("internal cache snapshot process failed");
    return result.stdout;
  };
  const cacheProcess: CloudflareSandbox["cacheProcess"] = async (runId, secrets) => {
    try {
      const { sandbox, session } = await internalSession(runId);
      let closed = false;
      const open = (): void => {
        if (closed) throw new Error("cache snapshot process is closed");
      };
      return {
        write: async (path, contents) => {
          open();
          const written = await session.writeFile(path, contents);
          if (!written.success) throw new Error("cache helper write failed");
          await internal(session, `chmod 700 ${shellQuote(path)}`);
        },
        execute: async (command, timeoutMs) => {
          open();
          return { stdout: await internal(session, command, timeoutMs) };
        },
        remove: async (path) => {
          open();
          const deleted = await session.deleteFile(path).catch(() => undefined);
          if (!deleted?.success) await internal(session, `rm -rf -- ${shellQuote(path)}`);
        },
        rename: async (from, to) => {
          open();
          const renamed = await session.renameFile(from, to);
          if (!renamed.success) throw new Error("cache staging rename failed");
        },
        close: async () => {
          if (closed) return;
          closed = true;
          const killed = await session.killAllProcesses().then(
            () => ({ state: "done" as const }),
            (error: unknown) => ({ state: "failed" as const, error }),
          );
          const deleted = await sandbox.deleteSession!(session.id);
          if (!deleted.success) throw new Error("cache snapshot session cleanup failed");
          if (killed.state === "failed") throw killed.error;
        },
      };
    } catch (error) {
      throw redactError(error, secrets);
    }
  };
  const cacheTransfer: CloudflareSandbox["cacheTransfer"] = (runId, secrets) => ({
    quiesce: async () => {
      try {
        const sandbox = await options.placement(await hashId("runway", [runId]));
        await sandbox.killAllProcesses();
        const opened = await internalSession(runId);
        const capabilityFiles = new Set<string>();
        let closed = false;
        const withCapability = async <T>(
          capability: CacheTransferCapability,
          work: (path: string, session: InternalSession) => Promise<T>,
        ): Promise<T> => {
          if (closed) throw new Error("cache transfer session is closed");
          const path = `/tmp/.runway-cache-capability-${crypto.randomUUID()}`;
          capabilityFiles.add(path);
          const written = await opened.session.writeFile(path, capability.url);
          if (!written.success) throw new Error("cache capability write failed");
          const outcome = await internal(opened.session, `chmod 600 ${shellQuote(path)}`)
            .then(async () => await work(path, opened.session))
            .then(
              (value) => ({ state: "done" as const, value }),
              (error: unknown) => ({ state: "failed" as const, error }),
            );
          const deleted = await opened.session.deleteFile(path).catch(() => undefined);
          capabilityFiles.delete(path);
          if (!deleted?.success) throw new Error("cache capability cleanup failed");
          if (outcome.state === "failed") throw outcome.error;
          return outcome.value;
        };
        const evidence = (stdout: string): { readonly bytes: number; readonly digest: string } => {
          const [bytesText, digest] = stdout.trim().split(/\s+/);
          const bytes = Number(bytesText);
          if (!Number.isSafeInteger(bytes) || bytes < 0 || !/^[0-9a-f]{64}$/.test(digest ?? "")) {
            throw new Error("invalid cache archive evidence");
          }
          return { bytes, digest: digest! };
        };
        return {
          inspect: async (path) =>
            evidence(
              await internal(
                opened.session,
                `stat -c %s -- ${shellQuote(path)}; sha256sum -- ${shellQuote(path)} | cut -d ' ' -f 1`,
              ),
            ),
          upload: async ({ path, capability }) =>
            await withCapability(capability, async (capabilityPath, session) => {
              const headers = Object.entries(capability.headers)
                .map(([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`)
                .join(" ");
              const status = (
                await internal(
                  session,
                  `url=$(cat ${shellQuote(capabilityPath)}); curl -sS -o /dev/null -w '%{http_code}' -X PUT ${headers} -T ${shellQuote(path)} "$url"`,
                )
              ).trim();
              if (status === "200" || status === "201") return "stored" as const;
              if (status === "412") return "precondition-failed" as const;
              throw new Error("cache upload failed");
            }),
          download: async ({ path, capability }) =>
            await withCapability(capability, async (capabilityPath, session) => {
              const partial = `${path}.partial`;
              try {
                await internal(
                  session,
                  `url=$(cat ${shellQuote(capabilityPath)}); rm -f -- ${shellQuote(partial)}; curl -sSf -o ${shellQuote(partial)} "$url"`,
                );
                const result = evidence(
                  await internal(
                    session,
                    `stat -c %s -- ${shellQuote(partial)}; sha256sum -- ${shellQuote(partial)} | cut -d ' ' -f 1`,
                  ),
                );
                await internal(session, `mv -- ${shellQuote(partial)} ${shellQuote(path)}`);
                return result;
              } catch (error) {
                await internal(session, `rm -f -- ${shellQuote(partial)}`).catch(() => undefined);
                throw error;
              }
            }),
          close: async () => {
            if (closed) return;
            closed = true;
            const killed = await opened.session.killAllProcesses().then(
              () => ({ state: "done" as const }),
              (error: unknown) => ({ state: "failed" as const, error }),
            );
            const capabilities = await Promise.all(
              [...capabilityFiles].map(
                async (path) => await opened.session.deleteFile(path).catch(() => undefined),
              ),
            );
            const deleted = await opened.sandbox.deleteSession!(opened.session.id);
            if (!deleted.success) throw new Error("cache transfer session cleanup failed");
            if (capabilities.some((result) => !result?.success)) {
              throw new Error("cache capability cleanup failed");
            }
            if (killed.state === "failed") throw killed.error;
          },
        } satisfies CacheTransferSession;
      } catch (error) {
        throw redactError(error, secrets);
      }
    },
  });
  const destroy = async (runId: string, secrets: ReadonlyArray<string>): Promise<void> => {
    try {
      const sandbox = await options.placement(await hashId("runway", [runId]));
      try {
        await sandbox.killAllProcesses();
      } finally {
        await sandbox.destroy();
      }
    } catch (error) {
      throw redactError(error, secrets);
    }
  };
  const quiesce = async (runId: string, secrets: ReadonlyArray<string>): Promise<void> => {
    try {
      const sandbox = await options.placement(await hashId("runway", [runId]));
      await sandbox.killAllProcesses();
    } catch (error) {
      throw redactError(error, secrets);
    }
  };
  return {
    prepare,
    execute,
    inspectCacheFile,
    quiesce,
    cacheProcess,
    cacheTransfer,
    destroy,
  };
};
