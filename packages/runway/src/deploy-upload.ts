import { toFile } from "cloudflare";

import type { CloudflareApi } from "./cloudflare-api.ts";
import {
  RUNNER_CONTAINER,
  SANDBOX_BINDING,
  SANDBOX_CLASS,
  SANDBOX_MIGRATION_TAG,
} from "./runner-config.ts";
import {
  ARTIFACT_BUCKET_BINDING,
  COMPATIBILITY_DATE,
  DYNAMIC_WORKFLOW_CLASS,
  isSecretSnapshotKeyBinding,
  LOADER_BINDING,
  WORKFLOW_BINDING,
} from "./worker-contract.ts";

type ScriptMetadata = Parameters<CloudflareApi["workers"]["scripts"]["update"]>[1]["metadata"];

interface WorkerUploadOptions {
  readonly accountId: string;
  readonly scriptName: string;
  readonly workflowName: string;
  readonly artifactBucketName: string;
  readonly contents: Uint8Array;
  readonly secretBindings: Readonly<Record<string, string>>;
  readonly needsSandboxMigration: boolean;
}

export const validateBindings = (secrets: ReadonlyArray<string>): void => {
  const names = new Map<string, string>();
  names.set(WORKFLOW_BINDING, "Runway workflow binding");
  names.set(LOADER_BINDING, "Runway worker loader binding");
  names.set(ARTIFACT_BUCKET_BINDING, "Runway workflow artifact binding");
  names.set(SANDBOX_BINDING, "Runway sandbox binding");
  for (const secret of secrets) {
    if (isSecretSnapshotKeyBinding(secret)) {
      throw new Error(`binding ${JSON.stringify(secret)} is used by Runway and a secret`);
    }
    const owner = names.get(secret);
    if (owner) {
      throw new Error(`binding ${JSON.stringify(secret)} is used by ${owner} and a secret`);
    }
  }
};

const metadataOf = (opts: WorkerUploadOptions): ScriptMetadata =>
  ({
    main_module: "worker.js",
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    keep_bindings: ["secret_text"],
    bindings: [
      { type: "worker_loader" as const, name: LOADER_BINDING },
      {
        type: "r2_bucket" as const,
        name: ARTIFACT_BUCKET_BINDING,
        bucket_name: opts.artifactBucketName,
      },
      {
        type: "workflow" as const,
        name: WORKFLOW_BINDING,
        workflow_name: opts.workflowName,
        class_name: DYNAMIC_WORKFLOW_CLASS,
      },
      {
        type: "durable_object_namespace" as const,
        name: SANDBOX_BINDING,
        class_name: SANDBOX_CLASS,
      },
      ...Object.entries(opts.secretBindings).map(([name, text]) => ({
        type: "secret_text" as const,
        name,
        text,
      })),
    ],
    containers: [RUNNER_CONTAINER],
    ...(opts.needsSandboxMigration
      ? {
          migrations: {
            new_tag: SANDBOX_MIGRATION_TAG,
            new_sqlite_classes: [SANDBOX_CLASS],
          },
        }
      : {}),
  }) as ScriptMetadata;

export const uploadWorker = async (cf: CloudflareApi, opts: WorkerUploadOptions): Promise<void> => {
  await cf.workers.scripts.update(opts.scriptName, {
    account_id: opts.accountId,
    metadata: metadataOf(opts),
    files: [await toFile(opts.contents, "worker.js", { type: "application/javascript+module" })],
  });
};
