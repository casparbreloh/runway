import { getSandbox, Sandbox, type ExecutionSession } from "@cloudflare/sandbox";

import {
  CacheTransferError,
  CloudflareCacheTransfer,
  type CacheTransferCapability,
  type CacheTransferSession,
} from "../../src/internal/cache/transfer.ts";

export { Sandbox };

interface Env {
  readonly CACHE_OBJECTS: R2Bucket;
  readonly BACKUP_BUCKET: R2Bucket;
  readonly CacheSandbox: DurableObjectNamespace<Sandbox>;
  readonly ACCOUNT_ID: string;
  readonly BUCKET_NAME: string;
  readonly CACHE_OBJECT_KEY: string;
  readonly DRIVER_TOKEN: string;
  readonly R2_ACCESS_KEY_ID: string;
  readonly R2_SECRET_ACCESS_KEY: string;
}

const ARCHIVE = "/tmp/runway-cache-transfer/archive.sqsh";
const INPUT = "/tmp/runway-cache-transfer/input";
const PAYLOAD = "Runway direct cache transfer evidence\n";
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const sha256 = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const archiveEvidence = (stdout: string): { readonly bytes: number; readonly digest: string } => {
  const [bytesText, digest] = stdout.trim().split(/\s+/);
  const bytes = Number(bytesText);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || !/^[0-9a-f]{64}$/.test(digest ?? "")) {
    throw new Error("Sandbox returned invalid archive evidence");
  }
  return { bytes, digest: digest! };
};

const run = async (session: ExecutionSession, command: string): Promise<string> => {
  const result = await session.exec(command, { origin: "internal", timeout: 5 * 60_000 });
  if (!result.success) throw new Error("internal cache transfer command failed");
  return result.stdout;
};

class LiveTransport {
  readonly #sandbox: Sandbox;
  readonly overlapCounts: number[] = [];

  constructor(sandbox: Sandbox) {
    this.#sandbox = sandbox;
  }

  async quiesce(): Promise<CacheTransferSession> {
    await this.#sandbox.killAllProcesses();
    const processes = await this.#sandbox.listProcesses();
    const overlap = processes.filter((process) => process.status === "running").length;
    this.overlapCounts.push(overlap);
    if (overlap !== 0) throw new Error("Sandbox user processes remained active");
    const session = await this.#sandbox.createSession({ cwd: "/" });
    const capabilityFiles = new Set<string>();

    const withCapability = async <T>(
      capability: CacheTransferCapability,
      work: (path: string) => Promise<T>,
    ): Promise<T> => {
      const path = `/tmp/runway-cache-capability-${crypto.randomUUID()}`;
      capabilityFiles.add(path);
      await session.writeFile(path, capability.url);
      try {
        await run(session, `chmod 600 ${shellQuote(path)}`);
        return await work(path);
      } finally {
        await session.deleteFile(path).catch(() => undefined);
        capabilityFiles.delete(path);
      }
    };

    return {
      inspect: async (path) =>
        archiveEvidence(
          await run(
            session,
            `stat -c %s ${shellQuote(path)}; sha256sum ${shellQuote(path)} | cut -d ' ' -f 1`,
          ),
        ),
      upload: async ({ path, capability }) =>
        await withCapability(capability, async (capabilityPath) => {
          const headers = Object.entries(capability.headers)
            .map(([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`)
            .join(" ");
          const status = (
            await run(
              session,
              `url=$(cat ${shellQuote(capabilityPath)}); curl -sS -o /dev/null -w '%{http_code}' -X PUT ${headers} -T ${shellQuote(path)} "$url"`,
            )
          ).trim();
          if (["200", "201"].includes(status)) return "stored" as const;
          if (status === "412") return "precondition-failed" as const;
          throw new Error("R2 cache upload returned an unexpected status");
        }),
      download: async ({ path, capability }) =>
        await withCapability(capability, async (capabilityPath) => {
          const partial = `${path}.partial`;
          try {
            await run(
              session,
              `url=$(cat ${shellQuote(capabilityPath)}); rm -f ${shellQuote(partial)}; curl -sSf -o ${shellQuote(partial)} "$url"`,
            );
            const evidence = archiveEvidence(
              await run(
                session,
                `stat -c %s ${shellQuote(partial)}; sha256sum ${shellQuote(partial)} | cut -d ' ' -f 1`,
              ),
            );
            await run(session, `mv ${shellQuote(partial)} ${shellQuote(path)}`);
            return evidence;
          } catch (error) {
            await session.deleteFile(partial).catch(() => undefined);
            throw error;
          }
        }),
      close: async () => {
        await session.killAllProcesses();
        await Promise.all(
          [...capabilityFiles].map(
            async (path) => await session.deleteFile(path).catch(() => undefined),
          ),
        );
        await this.#sandbox.deleteSession(session.id);
      },
    };
  }
}

const objectEvidence = async (
  bucket: R2Bucket,
  key: string,
): Promise<{ readonly bytes: number; readonly digest: string } | undefined> => {
  const object = await bucket.head(key);
  const digest = object?.customMetadata?.["runway-sha256"];
  return object && typeof digest === "string" ? { bytes: object.size, digest } : undefined;
};

const execute = async (env: Env): Promise<Record<string, unknown>> => {
  const sandbox = getSandbox(env.CacheSandbox, `cache-transfer-${crypto.randomUUID()}`);
  const transport = new LiveTransport(sandbox);
  const transferLogs: unknown[] = [];
  const runId = `cache-transfer-${crypto.randomUUID()}`;
  const totalStartedAt = Date.now();
  const payloadDigest = await sha256(PAYLOAD);
  let sdkBackupId: string | undefined;

  try {
    const seed = await sandbox.exec(
      `set -eu; rm -rf ${shellQuote(INPUT)} ${shellQuote(ARCHIVE)}; mkdir -p ${shellQuote(INPUT)}; printf %s ${shellQuote(PAYLOAD)} > ${shellQuote(`${INPUT}/payload.txt`)}; mkdir -p $(dirname ${shellQuote(ARCHIVE)}); mksquashfs ${shellQuote(INPUT)} ${shellQuote(ARCHIVE)} -comp lz4 -processors 8 -no-progress -noappend >/dev/null`,
      { timeout: 5 * 60_000 },
    );
    if (!seed.success) throw new Error("failed to create live SquashFS tracer archive");

    const transfer = new CloudflareCacheTransfer({
      accountId: env.ACCOUNT_ID,
      bucket: env.BUCKET_NAME,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      expiresInSeconds: 120,
      transport,
      objects: { head: async (key) => await objectEvidence(env.CACHE_OBJECTS, key) },
      log: (entry) => transferLogs.push(entry),
    });
    const request = { runId, key: env.CACHE_OBJECT_KEY, path: ARCHIVE };
    const putStartedAt = Date.now();
    const stored = await transfer.put(request);
    const putMs = Date.now() - putStartedAt;
    const repeatStartedAt = Date.now();
    const repeated = await transfer.put(request);
    const repeatPutMs = Date.now() - repeatStartedAt;

    const mutation = await sandbox.exec(
      `set -eu; rm -rf ${shellQuote(INPUT)} ${shellQuote(ARCHIVE)}; mkdir -p ${shellQuote(INPUT)}; printf %s ${shellQuote(`${PAYLOAD}mutated\n`)} > ${shellQuote(`${INPUT}/payload.txt`)}; mksquashfs ${shellQuote(INPUT)} ${shellQuote(ARCHIVE)} -comp lz4 -processors 8 -no-progress -noappend >/dev/null`,
      { timeout: 5 * 60_000 },
    );
    if (!mutation.success) throw new Error("failed to create mutation probe archive");
    let mutationRejected = false;
    try {
      await transfer.put(request);
    } catch (error) {
      mutationRejected =
        error instanceof CacheTransferError &&
        error.message === "uploaded cache archive failed verification";
    }
    if (!mutationRejected) throw new Error("repeat PUT could mutate immutable cache content");

    await sandbox.exec(`rm -f ${shellQuote(ARCHIVE)}`, { timeout: 30_000 });
    const getStartedAt = Date.now();
    const downloaded = await transfer.get({ ...request, expected: stored });
    const getMs = Date.now() - getStartedAt;
    const restored = await sandbox.exec(
      `unsquashfs -cat ${shellQuote(ARCHIVE)} payload.txt | sha256sum | cut -d ' ' -f 1`,
      { timeout: 30_000 },
    );
    if (!restored.success || restored.stdout.trim() !== payloadDigest) {
      throw new Error("downloaded SquashFS did not restore its exact payload");
    }

    const sdkInput = "/tmp/runway-sdk-backup";
    const sdkSeed = await sandbox.exec(
      `rm -rf ${shellQuote(sdkInput)}; mkdir -p ${shellQuote(sdkInput)}; printf %s ${shellQuote(PAYLOAD)} > ${shellQuote(`${sdkInput}/payload.txt`)}`,
      { timeout: 30_000 },
    );
    if (!sdkSeed.success) throw new Error("failed to seed SDK comparison backup");
    const sdkPutStartedAt = Date.now();
    const backup = await sandbox.createBackup({ dir: sdkInput, multipart: false });
    sdkBackupId = backup.id;
    const sdkPutMs = Date.now() - sdkPutStartedAt;
    await sandbox.exec(`rm -rf ${shellQuote(sdkInput)}`, { timeout: 30_000 });
    const sdkGetStartedAt = Date.now();
    await sandbox.restoreBackup(backup);
    const sdkGetMs = Date.now() - sdkGetStartedAt;
    const sdkRestored = await sandbox.exec(
      `sha256sum ${shellQuote(`${sdkInput}/payload.txt`)} | cut -d ' ' -f 1`,
      { timeout: 30_000 },
    );
    if (!sdkRestored.success || sdkRestored.stdout.trim() !== payloadDigest) {
      throw new Error("SDK backup comparison did not restore its payload");
    }

    return {
      outcome: "passed",
      transfer: {
        bytes: stored.bytes,
        digest: stored.digest,
        putMs,
        repeatPutMs,
        getMs,
        stored: stored.state,
        repeated: repeated.state,
        mutationRejected,
        downloaded,
        maxUserProcessOverlap: Math.max(...transport.overlapCounts),
        capabilityExpirySeconds: 120,
        r2Operations: { classAConditionalPut: 3, classBHead: 4, classBGet: 1 },
      },
      sdkBackup: {
        putMs: sdkPutMs,
        getMs: sdkGetMs,
        capabilityExpirySeconds: 3600,
        immutablePut: false,
        verification: "size-only",
      },
      security: {
        capabilityDelivery: "ephemeral mode-600 file in a quiescent private session",
        capabilityInCommand: false,
        capabilityInResponse: false,
        conditionalPut: true,
        digestVerified: true,
      },
      logs: transferLogs,
      totalMs: Date.now() - totalStartedAt,
    };
  } finally {
    await env.CACHE_OBJECTS.delete(env.CACHE_OBJECT_KEY).catch(() => undefined);
    if (sdkBackupId) {
      await env.BACKUP_BUCKET.delete([
        `backups/${sdkBackupId}/data.sqsh`,
        `backups/${sdkBackupId}/meta.json`,
      ]).catch(() => undefined);
    }
    await sandbox.destroy().catch(() => undefined);
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (request.headers.get("authorization") !== `Bearer ${env.DRIVER_TOKEN}`) {
      return new Response("unauthorized", { status: 401 });
    }
    try {
      return Response.json(await execute(env));
    } catch (error) {
      const message = error instanceof Error ? error.message : "live cache tracer failed";
      const unsafe =
        message.includes(env.R2_ACCESS_KEY_ID) ||
        message.includes(env.R2_SECRET_ACCESS_KEY) ||
        /https?:\/\/|X-Amz-|cloudflarestorage\.com/.test(message);
      return Response.json(
        {
          outcome: "failed",
          error: unsafe ? "live cache tracer failed" : message.slice(0, 1_024),
        },
        { status: 500 },
      );
    }
  },
};
