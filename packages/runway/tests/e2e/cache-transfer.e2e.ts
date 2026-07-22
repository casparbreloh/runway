import { randomUUID } from "node:crypto";
import { builtinModules } from "node:module";
import path from "node:path";
import process from "node:process";

import Cloudflare, { toFile } from "cloudflare";
import { build as esbuild } from "esbuild";
import { test } from "vitest";

import type { CloudflareApi } from "../../src/internal/cloudflare.ts";
import { collectResultItems, defaultClient, resultOf } from "../../src/internal/cloudflare.ts";
import { COMPATIBILITY_DATE } from "../../src/internal/runtime/contract.ts";
import { SANDBOX_APPLICATION, SANDBOX_CLASS } from "../../src/internal/sandbox/config.ts";
import {
  cloudflareAccountId as oneAccountId,
  cloudflareStatusIs as isStatus,
  cloudflareToken as tokenOf,
  containerApplications,
  deleteContainer,
  fetchWorkersDev,
  r2BucketExists as bucketExists,
  r2ObjectKeys as objectKeys,
} from "./support.ts";

const credentials = (): { readonly accessKeyId: string; readonly secretAccessKey: string } => {
  const accessKeyId = process.env.RUNWAY_CACHE_SMOKE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.RUNWAY_CACHE_SMOKE_R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "Set RUNWAY_CACHE_SMOKE_R2_ACCESS_KEY_ID and RUNWAY_CACHE_SMOKE_R2_SECRET_ACCESS_KEY. Wrangler OAuth is Cloudflare control-plane authorization, not an R2 S3 SigV4 credential, so it cannot presign the direct transfer. No Cloudflare resources were created.",
    );
  }
  return { accessKeyId, secretAccessKey };
};

const createSmokeContainer = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
): Promise<void> => {
  const versions = await collectResultItems(
    await cf.workers.scripts.versions.list(scriptName, { account_id: accountId, per_page: 1 }),
    (item) =>
      item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
        ? (item as { id: string }).id
        : undefined,
  );
  const versionId = versions[0];
  if (!versionId) throw new Error("smoke Worker has no version");
  const version = resultOf(
    await cf.workers.scripts.versions.get(versionId, {
      account_id: accountId,
      script_name: scriptName,
    }),
  ) as { resources?: { bindings?: readonly Record<string, unknown>[] } } | undefined;
  const binding = version?.resources?.bindings?.find(
    ({ type, name, class_name: className }) =>
      type === "durable_object_namespace" && name === "CacheSandbox" && className === "Sandbox",
  );
  if (typeof binding?.namespace_id !== "string") {
    throw new Error("smoke Worker has no Sandbox namespace");
  }
  await cf.containers.applications.create({
    account_id: accountId,
    body: {
      name: scriptName,
      ...SANDBOX_APPLICATION,
      durable_objects: { namespace_id: binding.namespace_id },
    },
  });
};

const buildWorker = async (): Promise<Uint8Array> => {
  const result = await esbuild({
    entryPoints: [path.join(import.meta.dirname, "cache-transfer-worker.e2e.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*", "node:*", ...builtinModules],
    write: false,
    plugins: [
      {
        name: "cache-smoke-sandbox",
        setup(build) {
          build.onResolve({ filter: /^@cloudflare\/sandbox$/ }, () => ({
            path: path.resolve(
              import.meta.dirname,
              "../node_modules/@cloudflare/sandbox/dist/index.js",
            ),
          }));
        },
      },
    ],
  });
  const output = result.outputFiles?.[0]?.contents;
  if (!output) throw new Error("esbuild returned no live cache tracer Worker");
  return output;
};

const uploadWorker = async (
  cf: Cloudflare,
  api: CloudflareApi,
  options: {
    readonly accountId: string;
    readonly scriptName: string;
    readonly bucket: string;
    readonly objectKey: string;
    readonly driverToken: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  },
): Promise<void> => {
  const contents = await buildWorker();
  const metadata = {
    main_module: "worker.js",
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    bindings: [
      {
        type: "durable_object_namespace",
        name: "CacheSandbox",
        class_name: "Sandbox",
      },
      { type: "r2_bucket", name: "CACHE_OBJECTS", bucket_name: options.bucket },
      { type: "r2_bucket", name: "BACKUP_BUCKET", bucket_name: options.bucket },
      { type: "plain_text", name: "ACCOUNT_ID", text: options.accountId },
      { type: "plain_text", name: "BUCKET_NAME", text: options.bucket },
      { type: "plain_text", name: "CLOUDFLARE_ACCOUNT_ID", text: options.accountId },
      { type: "plain_text", name: "BACKUP_BUCKET_NAME", text: options.bucket },
      { type: "plain_text", name: "CACHE_OBJECT_KEY", text: options.objectKey },
      { type: "secret_text", name: "DRIVER_TOKEN", text: options.driverToken },
      { type: "secret_text", name: "R2_ACCESS_KEY_ID", text: options.accessKeyId },
      { type: "secret_text", name: "R2_SECRET_ACCESS_KEY", text: options.secretAccessKey },
    ],
    containers: [{ class_name: SANDBOX_CLASS }],
    migrations: {
      new_tag: "runway-cache-smoke-v1",
      new_sqlite_classes: [SANDBOX_CLASS],
    },
  } as Parameters<Cloudflare["workers"]["scripts"]["update"]>[1]["metadata"];
  await cf.workers.scripts.update(options.scriptName, {
    account_id: options.accountId,
    metadata,
    files: [await toFile(contents, "worker.js", { type: "application/javascript+module" })],
  });
  await createSmokeContainer(api, options.accountId, options.scriptName);
  await cf.workers.scripts.subdomain.create(options.scriptName, {
    account_id: options.accountId,
    enabled: true,
  });
};

const run = async (): Promise<void> => {
  const { accessKeyId, secretAccessKey } = credentials();
  const token = await tokenOf();
  const cf = new Cloudflare({ apiToken: token });
  const api = defaultClient(token);
  const accountId = await oneAccountId(cf);
  const suffix = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
  const scriptName = `runway-cache-smoke-${suffix}`;
  const containerName = scriptName;
  const suppliedBucket = process.env.RUNWAY_CACHE_SMOKE_BUCKET;
  const bucket = suppliedBucket ?? `runway-cache-smoke-${suffix}`;
  const bucketOwned = suppliedBucket === undefined;
  const objectKey = `smoke/${randomUUID()}.sqsh`;
  const driverToken = `driver-${randomUUID()}`;
  let scriptIntentOwned = false;
  let bucketIntentOwned = false;
  let smokeError: unknown;
  let report: Record<string, unknown> | undefined;
  const cleanupErrors: string[] = [];

  try {
    const scriptCollision = await cf.workers.scripts
      .get(scriptName, { account_id: accountId })
      .then(
        () => true,
        (error) => {
          if (isStatus(error, 404)) return false;
          throw error;
        },
      );
    const containerCollision = (await containerApplications(token, accountId)).some(
      ({ name }) => name === containerName,
    );
    if (scriptCollision || containerCollision) {
      throw new Error("Refusing to overwrite a pre-existing cache tracer resource");
    }
    scriptIntentOwned = true;
    if (bucketOwned) {
      if (await bucketExists(cf, accountId, bucket)) {
        throw new Error(`Refusing to overwrite pre-existing bucket ${bucket}`);
      }
      bucketIntentOwned = true;
      await cf.r2.buckets.create({ account_id: accountId, name: bucket });
    } else {
      if (!(await bucketExists(cf, accountId, bucket))) {
        throw new Error(`Configured cache tracer bucket does not exist: ${bucket}`);
      }
      if ((await objectKeys(cf, accountId, bucket)).size > 0) {
        throw new Error("Configured cache tracer bucket must be empty so cleanup is exact");
      }
    }

    await uploadWorker(cf, api, {
      accountId,
      scriptName,
      bucket,
      objectKey,
      driverToken,
      accessKeyId,
      secretAccessKey,
    });
    const subdomain = resultOf(await cf.workers.subdomains.get({ account_id: accountId })) as {
      subdomain?: unknown;
    } | null;
    if (typeof subdomain?.subdomain !== "string") {
      throw new Error("Account has no workers.dev subdomain");
    }
    const response = await fetchWorkersDev(
      `https://${scriptName}.${subdomain.subdomain}.workers.dev/`,
      { method: "POST", headers: { authorization: `Bearer ${driverToken}` } },
    );
    if (response.status !== 200) {
      throw new Error(`Live cache tracer returned ${response.status}: ${response.text}`);
    }
    report = JSON.parse(response.text) as Record<string, unknown>;
    const serialized = JSON.stringify(report);
    if (
      serialized.includes(accessKeyId) ||
      serialized.includes(secretAccessKey) ||
      /X-Amz-|cloudflarestorage\.com/.test(serialized)
    ) {
      throw new Error("Live cache tracer exposed a transfer capability");
    }
  } catch (error) {
    smokeError = error;
  } finally {
    try {
      if (scriptIntentOwned) {
        await cf.workers.scripts.delete(scriptName, { account_id: accountId });
      }
    } catch (error) {
      if (!isStatus(error, 404)) cleanupErrors.push(`Worker: ${String(error)}`);
    }
    try {
      const application = (await containerApplications(token, accountId)).find(
        ({ name }) => name === containerName,
      );
      if (application) await deleteContainer(token, accountId, application.id);
    } catch (error) {
      cleanupErrors.push(`container: ${String(error)}`);
    }
    try {
      for (const key of await objectKeys(cf, accountId, bucket)) {
        await cf.r2.buckets.objects.delete(key, { account_id: accountId, bucket_name: bucket });
      }
      if (bucketIntentOwned) await cf.r2.buckets.delete(bucket, { account_id: accountId });
    } catch (error) {
      cleanupErrors.push(`R2: ${String(error)}`);
    }
    try {
      const remainingScript = await cf.workers.scripts
        .get(scriptName, { account_id: accountId })
        .then(
          () => true,
          (error) => {
            if (isStatus(error, 404)) return false;
            throw error;
          },
        );
      const remainingContainer = (await containerApplications(token, accountId)).some(
        ({ name }) => name === containerName,
      );
      const remainingObjects = await objectKeys(cf, accountId, bucket);
      if (remainingScript) cleanupErrors.push(`Worker still exists: ${scriptName}`);
      if (remainingContainer) cleanupErrors.push(`container still exists: ${containerName}`);
      if (remainingObjects.size > 0) {
        cleanupErrors.push(`R2 objects still exist: ${[...remainingObjects].join(", ")}`);
      }
      if (bucketIntentOwned && (await bucketExists(cf, accountId, bucket))) {
        cleanupErrors.push(`bucket still exists: ${bucket}`);
      }
    } catch (error) {
      cleanupErrors.push(`verification: ${String(error)}`);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new Error(`Live cache tracer cleanup failed: ${cleanupErrors.join("; ")}`);
  }
  if (smokeError) throw smokeError;
  if (!report) throw new Error("Live cache tracer completed without a report");
  console.log(
    JSON.stringify(
      {
        ...report,
        cleanup: {
          workerDeleted: true,
          containerDeleted: true,
          objectsDeleted: true,
          bucket: bucketOwned ? "deleted" : "preserved-empty",
        },
      },
      null,
      2,
    ),
  );
};

test("transfers cache archives through the deployed Sandbox and R2", async () => {
  await run().catch((error) => {
    let message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    for (const secret of [
      process.env.RUNWAY_CACHE_SMOKE_R2_ACCESS_KEY_ID,
      process.env.RUNWAY_CACHE_SMOKE_R2_SECRET_ACCESS_KEY,
    ].filter((value): value is string => !!value)) {
      message = message.replaceAll(secret, "***");
    }
    throw new Error(message.replaceAll(/https?:\/\/\S+/g, "***"));
  });
});
