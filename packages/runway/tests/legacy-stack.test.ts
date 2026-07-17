import { expect, test } from "vitest";

import {
  LegacyStack,
  type LegacyStackControl,
  type LegacyStackReceipt,
} from "../src/legacy-stack.ts";
import { stackIdOf } from "../src/stack.ts";

const digest = (digit: string): string => `sha256:${digit.repeat(64)}`;

const receipt: LegacyStackReceipt = {
  schema: 1,
  authority: "delete-only",
  owner: {
    accountId: "account-1",
    repositoryId: "github:1260842673",
    stackId: stackIdOf("account-1", "github:1260842673"),
  },
  worker: {
    name: "runway-monorepo",
    versionId: "worker-version-current",
    deploymentId: "worker-deployment-current",
    retainedVersionIds: ["worker-version-old"],
    retainedDeploymentIds: ["worker-deployment-old"],
  },
  workflow: { name: "runway-monorepo", id: "workflow-id" },
  container: {
    name: "runway-monorepo-Sandbox",
    id: "container-id",
    rolloutId: "rollout-id",
    imageTag: "docker.io/cloudflare/sandbox:0.12.3",
    resolvedImageDigest: digest("2"),
    platform: { os: "linux", architecture: "amd64" },
  },
  namespaces: [
    {
      binding: "RUNWAY_GITHUB_COORDINATOR",
      name: "runway-monorepo_RunwayGitHubCoordinator",
      className: "RunwayGitHubCoordinator",
      id: "coordinator-namespace-id",
      scriptName: "runway-monorepo",
    },
    {
      binding: "RunwaySandbox",
      name: "runway-monorepo_Sandbox",
      className: "Sandbox",
      id: "sandbox-namespace-id",
      scriptName: "runway-monorepo",
    },
  ],
  bindings: [
    { name: "LOADER", type: "worker_loader" },
    { name: "RUNWAY_ARTIFACTS", type: "r2_bucket", target: "runway-account-1" },
  ],
  secretNames: [
    "RUNWAY_SECRET_SNAPSHOT_KEY",
    "RUNWAY_SECRET_SNAPSHOT_KEY_4583caa3b8b643ec9cbeb7ecd768817d",
  ],
  schedules: [],
  workersDev: { enabled: true, previewsEnabled: true },
  routes: [],
  secretSnapshot: {
    binding: "RUNWAY_SECRET_SNAPSHOT_KEY",
    ownedKeyBindings: ["RUNWAY_SECRET_SNAPSHOT_KEY_4583caa3b8b643ec9cbeb7ecd768817d"],
    status: "runway-prefix-current-target-unverifiable",
    disposition: "prune-after-successful-replacement",
  },
  buckets: [
    {
      name: "runway-account-1",
      authority: "preserve-only",
      objectCount: 46,
      lifecycle: "default-multipart-abort-7-days",
      publicAccess: false,
      managedDomain: "pub-artifacts.r2.dev",
      customDomains: [],
      cors: false,
    },
    {
      name: "runway-cache-account-1",
      authority: "delete-after-replacement",
      objects: [{ key: "caches/one.tar.gz", size: 10, etag: "etag-one" }],
      lifecycle: "default-multipart-abort-7-days",
      publicAccess: true,
      managedDomain: "pub-cache.r2.dev",
      customDomains: [],
      cors: false,
    },
  ],
};

class MemoryControl implements LegacyStackControl {
  #value: string | undefined;
  inventoryValue = structuredClone(receipt);
  digest = receipt.container.resolvedImageDigest;

  inventory(): Promise<LegacyStackReceipt> {
    return Promise.resolve(structuredClone(this.inventoryValue));
  }

  resolveImageDigest(): Promise<string> {
    return Promise.resolve(this.digest);
  }

  read(): Promise<string | undefined> {
    return Promise.resolve(this.#value);
  }

  writeOnce(value: string): Promise<void> {
    if (this.#value !== undefined && this.#value !== value)
      throw new Error("legacy receipt exists");
    this.#value = value;
    return Promise.resolve();
  }
}

test("LegacyStack persists and rereads an exact deletion-only receipt", async () => {
  const control = new MemoryControl();
  const stack = new LegacyStack(receipt, control);

  await expect(stack.capture()).resolves.toEqual(receipt);
  await expect(stack.read()).resolves.toEqual(receipt);
  await expect(stack.capture()).resolves.toEqual(receipt);
  expect("sync" in stack).toBe(false);
  expect("admit" in stack).toBe(false);
});

test("LegacyStack fails closed on inventory, independently resolved digest, or snapshot drift", async () => {
  const inventory = new MemoryControl();
  inventory.inventoryValue = {
    ...inventory.inventoryValue,
    worker: { ...inventory.inventoryValue.worker, versionId: "different" },
  };
  await expect(new LegacyStack(receipt, inventory).capture()).rejects.toThrow(
    "legacy Stack inventory",
  );

  const image = new MemoryControl();
  image.digest = digest("f");
  await expect(new LegacyStack(receipt, image).capture()).rejects.toThrow(
    "legacy Stack image digest",
  );

  const snapshot = new MemoryControl();
  snapshot.inventoryValue = {
    ...snapshot.inventoryValue,
    secretSnapshot: { ...snapshot.inventoryValue.secretSnapshot, ownedKeyBindings: [] },
  };
  await expect(new LegacyStack(receipt, snapshot).capture()).rejects.toThrow(
    "legacy Stack inventory",
  );
});
