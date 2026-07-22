import { createHash } from "node:crypto";

import { resultOf, type CloudflareApi } from "../cloudflare.ts";
import type { BuiltWorkflowArtifact, PreparedRelease } from "../publish/artifacts.ts";
import { workflowArtifactKey } from "../runtime/artifact.ts";
import {
  activeReleaseKey,
  decodeActiveRelease,
  decodeReleaseRegistry,
  encodeActiveRelease,
  releaseRegistryKey,
  type ActiveRelease,
  type ReleaseRegistry,
} from "./registry.ts";

const status = (error: unknown, expected: number): boolean =>
  !!error && typeof error === "object" && "status" in error && error.status === expected;

const bytesOf = async (value: unknown): Promise<Uint8Array> => {
  const result = resultOf(value);
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (result instanceof Response) return new Uint8Array(await result.arrayBuffer());
  if (typeof result === "string") return new TextEncoder().encode(result);
  if (result && typeof result === "object" && "arrayBuffer" in result) {
    return new Uint8Array(await (result as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
  }
  throw new Error("invalid Cloudflare release object");
};

const etagOf = (value: unknown): string | undefined => {
  const result = resultOf(value);
  if (result instanceof Response) return result.headers.get("etag") ?? undefined;
  if (result && typeof result === "object") {
    const etag =
      (result as { etag?: unknown; httpEtag?: unknown }).etag ??
      (result as { httpEtag?: unknown }).httpEtag;
    if (typeof etag === "string" && etag.length > 0) return etag;
  }
  return undefined;
};

const digestOf = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

export interface ReleaseActivation {
  readonly active: ActiveRelease;
  readonly artifactVersions: readonly string[];
  readonly changed: boolean;
}

export interface CloudflareReleaseOptions {
  readonly cf: CloudflareApi;
  readonly accountId: string;
  readonly bucket: string;
  readonly deploymentName: string;
  readonly isAncestor?: (ancestor: string, descendant: string) => Promise<boolean>;
}

export class CloudflareReleaseControl {
  readonly #opts: CloudflareReleaseOptions;

  constructor(opts: CloudflareReleaseOptions) {
    this.#opts = opts;
  }

  async current(): Promise<
    { readonly active: ActiveRelease; readonly registry: ReleaseRegistry } | undefined
  > {
    const observed = await this.#readActive();
    if (!observed) return undefined;
    const object = await this.#opts.cf.r2.buckets.objects.get(
      releaseRegistryKey(this.#opts.deploymentName, observed.active.registryVersion),
      { account_id: this.#opts.accountId, bucket_name: this.#opts.bucket },
    );
    const contents = await bytesOf(object);
    if (digestOf(contents) !== observed.active.registryVersion) {
      throw new Error("invalid active release registry hash");
    }
    const registry = decodeReleaseRegistry(contents);
    if (
      registry.deploymentName !== this.#opts.deploymentName ||
      registry.repository.commit !== observed.active.commit
    ) {
      throw new Error("active release registry does not match its pointer");
    }
    return { active: observed.active, registry };
  }

  async activate(release: PreparedRelease): Promise<ReleaseActivation> {
    if (
      release.registry.deploymentName !== this.#opts.deploymentName ||
      digestOf(release.registryContents) !== release.registryVersion
    ) {
      throw new Error("release deployment mismatch");
    }
    const decoded = decodeReleaseRegistry(release.registryContents);
    const artifacts = new Map(
      release.artifacts.map((artifact) => [artifact.workflowId, artifact.artifactVersion]),
    );
    if (decoded.routes.some((route) => artifacts.get(route.id) !== route.artifactVersion)) {
      throw new Error("release registry does not match its artifacts");
    }
    for (const artifact of release.artifacts) await this.#persistArtifact(artifact);
    await this.#persistImmutable(
      releaseRegistryKey(this.#opts.deploymentName, release.registryVersion),
      release.registryContents,
      release.registryVersion,
    );

    const candidate: ActiveRelease = {
      schema: 1,
      commit: release.registry.repository.commit,
      registryVersion: release.registryVersion,
    };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const observed = await this.#readActive();
      if (
        observed?.active.commit === candidate.commit &&
        observed.active.registryVersion === candidate.registryVersion
      ) {
        return {
          active: observed.active,
          artifactVersions: release.artifacts.map(({ artifactVersion }) => artifactVersion),
          changed: false,
        };
      }
      if (
        observed &&
        this.#opts.isAncestor &&
        !(await this.#opts.isAncestor(observed.active.commit, candidate.commit))
      ) {
        throw new Error(`release ${candidate.commit} was superseded by ${observed.active.commit}`);
      }
      try {
        await this.#opts.cf.r2.buckets.objects.upload(
          activeReleaseKey(this.#opts.deploymentName),
          encodeActiveRelease(candidate),
          { account_id: this.#opts.accountId, bucket_name: this.#opts.bucket },
          {
            headers: observed?.etag ? { "If-Match": observed.etag } : { "If-None-Match": "*" },
          },
        );
      } catch (error) {
        if (status(error, 409) || status(error, 412)) continue;
        throw error;
      }
      const winning = await this.#readActive();
      if (
        winning?.active.commit === candidate.commit &&
        winning.active.registryVersion === candidate.registryVersion
      ) {
        return {
          active: winning.active,
          artifactVersions: release.artifacts.map(({ artifactVersion }) => artifactVersion),
          changed: true,
        };
      }
    }
    throw new Error("release activation lost concurrent updates");
  }

  async #readActive(): Promise<
    { readonly active: ActiveRelease; readonly etag?: string } | undefined
  > {
    let object: unknown;
    try {
      object = await this.#opts.cf.r2.buckets.objects.get(
        activeReleaseKey(this.#opts.deploymentName),
        { account_id: this.#opts.accountId, bucket_name: this.#opts.bucket },
      );
    } catch (error) {
      if (status(error, 404)) return undefined;
      throw error;
    }
    const etag = etagOf(object);
    return {
      active: decodeActiveRelease(await bytesOf(object)),
      ...(etag === undefined ? {} : { etag }),
    };
  }

  async #persistArtifact(artifact: BuiltWorkflowArtifact): Promise<void> {
    if (digestOf(artifact.contents) !== artifact.artifactVersion) {
      throw new Error(`workflow artifact ${artifact.workflowId} has an invalid digest`);
    }
    await this.#persistImmutable(
      workflowArtifactKey(artifact.artifactVersion),
      artifact.contents,
      artifact.artifactVersion,
    );
  }

  async #persistImmutable(key: string, contents: Uint8Array, digest: string): Promise<void> {
    let existing: unknown;
    try {
      existing = await this.#opts.cf.r2.buckets.objects.get(key, {
        account_id: this.#opts.accountId,
        bucket_name: this.#opts.bucket,
      });
    } catch (error) {
      if (!status(error, 404)) throw error;
    }
    if (existing !== undefined) {
      if (digestOf(await bytesOf(existing)) !== digest) {
        throw new Error(`immutable release object conflict: ${key}`);
      }
      return;
    }
    try {
      await this.#opts.cf.r2.buckets.objects.upload(
        key,
        contents,
        { account_id: this.#opts.accountId, bucket_name: this.#opts.bucket },
        { headers: { "If-None-Match": "*" } },
      );
    } catch (error) {
      if (!status(error, 409) && !status(error, 412)) throw error;
    }
    const stored = await this.#opts.cf.r2.buckets.objects.get(key, {
      account_id: this.#opts.accountId,
      bucket_name: this.#opts.bucket,
    });
    if (digestOf(await bytesOf(stored)) !== digest) {
      throw new Error(`immutable release object conflict: ${key}`);
    }
  }
}
