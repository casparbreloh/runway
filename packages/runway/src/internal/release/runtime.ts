import { decodeWorkflowArtifact, workflowArtifactKey } from "../runtime/artifact.ts";
import type { RepositorySource } from "../source/repository.ts";
import { releasePreflightOf, releaseUploadOf, type ReleaseArtifactIdentity } from "./protocol.ts";
import {
  activeReleaseKey,
  decodeActiveRelease,
  decodeReleaseRegistry,
  encodeActiveRelease,
  releaseRegistryKey,
  type ActiveRelease,
  type ReleaseRegistry,
} from "./registry.ts";

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = async (bytes: BufferSource): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", bytes));

const bytesFromBase64 = (value: string): Uint8Array =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

const sameActive = (left: ActiveRelease | null, right: ActiveRelease | null): boolean =>
  left?.commit === right?.commit && left?.registryVersion === right?.registryVersion;

const current = async (
  bucket: R2Bucket,
  deploymentName: string,
): Promise<
  | {
      readonly active: ActiveRelease;
      readonly registry: ReleaseRegistry;
      readonly object: R2Object;
    }
  | undefined
> => {
  const object = await bucket.get(activeReleaseKey(deploymentName));
  if (!object || !object.body) return undefined;
  const active = decodeActiveRelease(await object.arrayBuffer());
  const registryObject = await bucket.get(
    releaseRegistryKey(deploymentName, active.registryVersion),
  );
  if (!registryObject || !registryObject.body) throw new Error("missing release registry");
  const contents = await registryObject.arrayBuffer();
  if ((await sha256(contents)) !== active.registryVersion) {
    throw new Error("invalid release registry hash");
  }
  const registry = decodeReleaseRegistry(contents);
  if (registry.deploymentName !== deploymentName || registry.repository.commit !== active.commit) {
    throw new Error("release registry does not match its pointer");
  }
  return { active, registry, object };
};

const objectBytes = async (
  bucket: R2Bucket,
  key: string,
  digest: string,
  missingMessage: string,
): Promise<Uint8Array> => {
  const object = await bucket.get(key);
  if (!object?.body) throw new Error(missingMessage);
  const contents = new Uint8Array(await object.arrayBuffer());
  if ((await sha256(contents)) !== digest) {
    throw new Error(`immutable release object conflict: ${key}`);
  }
  return contents;
};

export interface ReleasePolicy {
  readonly deploymentName: string;
  readonly authorSecretNames: readonly string[];
  readonly repository: Omit<RepositorySource, "commit">;
  readonly defaultBranch?: string;
  readonly github?: ReleaseRegistry["github"];
}

export const assertReleasePolicy = (registry: ReleaseRegistry, policy: ReleasePolicy): void => {
  const allowedSecrets = [...policy.authorSecretNames].sort();
  const hasGitHubRoutes = registry.routes.some(({ type }) => type === "github");
  const githubMatches =
    registry.github !== undefined &&
    policy.github !== undefined &&
    registry.github.installationId === policy.github.installationId &&
    JSON.stringify(registry.github.repository) === JSON.stringify(policy.github.repository);
  if (
    registry.deploymentName !== policy.deploymentName ||
    registry.secretNames.join("\0") !== allowedSecrets.join("\0") ||
    registry.repository.remote !== policy.repository.remote ||
    JSON.stringify(registry.repository.authentication) !==
      JSON.stringify(policy.repository.authentication) ||
    registry.defaultBranch !== policy.defaultBranch ||
    hasGitHubRoutes !== (registry.github !== undefined) ||
    (registry.github !== undefined && !githubMatches)
  ) {
    throw new Error("release does not match structural policy");
  }
};

const persistImmutable = async (
  bucket: R2Bucket,
  key: string,
  contents: Uint8Array,
  digest: string,
): Promise<void> => {
  const existing = await bucket.get(key);
  if (existing?.body) {
    if ((await sha256(await existing.arrayBuffer())) !== digest) {
      throw new Error(`immutable release object conflict: ${key}`);
    }
    return;
  }
  await bucket.put(key, contents, { onlyIf: new Headers({ "if-none-match": "*" }) });
  await objectBytes(bucket, key, digest, `immutable release object disappeared: ${key}`);
};

export const preflightRelease = async (
  bucket: R2Bucket,
  deploymentName: string,
  value: unknown,
): Promise<{
  readonly schema: 1;
  readonly missingRegistry: boolean;
  readonly missingArtifacts: readonly ReleaseArtifactIdentity[];
}> => {
  const preflight = releasePreflightOf(value);
  const missingArtifacts: ReleaseArtifactIdentity[] = [];
  for (const artifact of preflight.artifacts) {
    if (!(await bucket.head(workflowArtifactKey(artifact.artifactVersion)))) {
      missingArtifacts.push(artifact);
    }
  }
  return {
    schema: 1,
    missingRegistry: !(await bucket.head(
      releaseRegistryKey(deploymentName, preflight.registryVersion),
    )),
    missingArtifacts,
  };
};

export const readRelease = async (
  bucket: R2Bucket,
  deploymentName: string,
): Promise<{ readonly active: ActiveRelease; readonly registry: ReleaseRegistry } | undefined> => {
  const release = await current(bucket, deploymentName);
  return release && { active: release.active, registry: release.registry };
};

export const activateRelease = async (
  bucket: R2Bucket,
  deploymentName: string,
  authorSecretNames: readonly string[],
  repository: Omit<RepositorySource, "commit">,
  defaultBranch: string | undefined,
  github: ReleaseRegistry["github"] | undefined,
  value: unknown,
): Promise<{ readonly changed: boolean; readonly active: ActiveRelease }> => {
  const upload = releaseUploadOf(value);
  const registryKey = releaseRegistryKey(deploymentName, upload.registryVersion);
  let registryContents: Uint8Array;
  if (upload.registryContents === undefined) {
    registryContents = await objectBytes(
      bucket,
      registryKey,
      upload.registryVersion,
      "missing release registry",
    );
  } else {
    registryContents = bytesFromBase64(upload.registryContents);
    if ((await sha256(registryContents)) !== upload.registryVersion) {
      throw new Error("invalid release registry hash");
    }
    await persistImmutable(bucket, registryKey, registryContents, upload.registryVersion);
  }
  const registry = decodeReleaseRegistry(registryContents);
  assertReleasePolicy(registry, {
    deploymentName,
    authorSecretNames,
    repository,
    ...(defaultBranch ? { defaultBranch } : {}),
    ...(github ? { github } : {}),
  });
  const allowedSecrets = [...authorSecretNames].sort();

  const versions = new Map<string, string>();
  for (const uploaded of upload.artifacts) {
    const key = workflowArtifactKey(uploaded.artifactVersion);
    let contents: Uint8Array;
    if (uploaded.contents === undefined) {
      contents = await objectBytes(
        bucket,
        key,
        uploaded.artifactVersion,
        `missing workflow artifact: ${uploaded.workflowId}`,
      );
    } else {
      contents = bytesFromBase64(uploaded.contents);
      if ((await sha256(contents)) !== uploaded.artifactVersion) {
        throw new Error("invalid workflow artifact hash");
      }
      await persistImmutable(bucket, key, contents, uploaded.artifactVersion);
    }
    const artifact = decodeWorkflowArtifact(contents);
    if (
      artifact.deploymentName !== deploymentName ||
      artifact.workflowId !== uploaded.workflowId ||
      JSON.stringify(artifact.repository) !== JSON.stringify(registry.repository) ||
      artifact.secrets.some((secret) => !allowedSecrets.includes(secret))
    ) {
      throw new Error("workflow artifact does not match release");
    }
    versions.set(uploaded.workflowId, uploaded.artifactVersion);
  }
  if (registry.routes.some((route) => versions.get(route.id) !== route.artifactVersion)) {
    throw new Error("release registry does not match its artifacts");
  }

  const observed = await current(bucket, deploymentName);
  if (!sameActive(observed?.active ?? null, upload.expected)) {
    throw new Error("release activation lost a concurrent update");
  }
  const candidate: ActiveRelease = {
    schema: 1,
    commit: registry.repository.commit,
    registryVersion: upload.registryVersion,
  };
  if (sameActive(observed?.active ?? null, candidate)) return { changed: false, active: candidate };
  const stored = await bucket.put(
    activeReleaseKey(deploymentName),
    encodeActiveRelease(candidate),
    {
      onlyIf: observed
        ? { etagMatches: observed.object.etag }
        : new Headers({ "if-none-match": "*" }),
    },
  );
  if (!stored) throw new Error("release activation lost a concurrent update");
  return { changed: true, active: candidate };
};
