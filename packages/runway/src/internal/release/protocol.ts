import {
  decodeActiveRelease,
  decodeReleaseRegistry,
  type ActiveRelease,
  type ReleaseRegistry,
} from "./registry.ts";

export interface ReleaseArtifactIdentity {
  readonly workflowId: string;
  readonly artifactVersion: string;
}

export interface ReleasePreflight {
  readonly schema: 1;
  readonly registryVersion: string;
  readonly artifacts: readonly ReleaseArtifactIdentity[];
}

export interface ReleasePreflightResult {
  readonly schema: 1;
  readonly missingRegistry: boolean;
  readonly missingArtifacts: readonly ReleaseArtifactIdentity[];
}

export interface ReleaseUploadArtifact extends ReleaseArtifactIdentity {
  readonly contents?: string;
}

export interface ReleaseUpload {
  readonly schema: 1;
  readonly expected: ActiveRelease | null;
  readonly registryVersion: string;
  readonly registryContents?: string;
  readonly artifacts: readonly ReleaseUploadArtifact[];
}

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

const recordOf = (value: unknown, message: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
};

const versionOf = (value: unknown, message: string): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(message);
  return value;
};

const base64Of = (value: unknown, message: string): string => {
  if (
    typeof value !== "string" ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(message);
  }
  return value;
};

const artifactOf = (
  value: unknown,
  contents: "forbidden" | "optional",
  message: string,
): ReleaseUploadArtifact => {
  const artifact = recordOf(value, message);
  const keys =
    contents === "optional" && artifact.contents !== undefined
      ? ["artifactVersion", "contents", "workflowId"]
      : ["artifactVersion", "workflowId"];
  if (
    !exactKeys(artifact, keys) ||
    typeof artifact.workflowId !== "string" ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(artifact.workflowId)
  ) {
    throw new Error(message);
  }
  const identity = {
    workflowId: artifact.workflowId,
    artifactVersion: versionOf(artifact.artifactVersion, message),
  };
  if (artifact.contents === undefined) return identity;
  if (contents === "forbidden") throw new Error(message);
  return { ...identity, contents: base64Of(artifact.contents, message) };
};

const artifactsOf = (
  value: unknown,
  contents: "forbidden" | "optional",
  message: string,
): readonly ReleaseUploadArtifact[] => {
  if (!Array.isArray(value)) throw new Error(message);
  const artifacts = value.map((artifact) => artifactOf(artifact, contents, message));
  const workflowIds = artifacts.map(({ workflowId }) => workflowId);
  const versions = artifacts.map(({ artifactVersion }) => artifactVersion);
  if (
    new Set(workflowIds).size !== workflowIds.length ||
    new Set(versions).size !== versions.length
  ) {
    throw new Error(message);
  }
  return artifacts;
};

const activeOf = (value: unknown, message: string): ActiveRelease => {
  try {
    return decodeActiveRelease(new TextEncoder().encode(JSON.stringify(value)));
  } catch {
    throw new Error(message);
  }
};

export const releasePreflightOf = (value: unknown): ReleasePreflight => {
  const message = "invalid release preflight";
  const preflight = recordOf(value, message);
  if (!exactKeys(preflight, ["artifacts", "registryVersion", "schema"]) || preflight.schema !== 1) {
    throw new Error(message);
  }
  return {
    schema: 1,
    registryVersion: versionOf(preflight.registryVersion, message),
    artifacts: artifactsOf(preflight.artifacts, "forbidden", message),
  };
};

export const releasePreflightResultOf = (value: unknown): ReleasePreflightResult => {
  const message = "invalid release preflight response";
  const result = recordOf(value, message);
  if (
    !exactKeys(result, ["missingArtifacts", "missingRegistry", "schema"]) ||
    result.schema !== 1 ||
    typeof result.missingRegistry !== "boolean"
  ) {
    throw new Error(message);
  }
  return {
    schema: 1,
    missingRegistry: result.missingRegistry,
    missingArtifacts: artifactsOf(result.missingArtifacts, "forbidden", message),
  };
};

export const releaseUploadOf = (value: unknown): ReleaseUpload => {
  const message = "invalid release upload";
  const upload = recordOf(value, message);
  const keys = [
    "artifacts",
    "expected",
    ...(upload.registryContents === undefined ? [] : ["registryContents"]),
    "registryVersion",
    "schema",
  ];
  if (!exactKeys(upload, keys) || upload.schema !== 1) throw new Error(message);
  const expected = upload.expected === null ? null : activeOf(upload.expected, message);
  return {
    schema: 1,
    expected,
    registryVersion: versionOf(upload.registryVersion, message),
    ...(upload.registryContents === undefined
      ? {}
      : { registryContents: base64Of(upload.registryContents, message) }),
    artifacts: artifactsOf(upload.artifacts, "optional", message),
  };
};

export const currentReleaseResultOf = (
  value: unknown,
): { readonly active: ActiveRelease; readonly registry: ReleaseRegistry } => {
  const message = "invalid current release response";
  const result = recordOf(value, message);
  if (!exactKeys(result, ["active", "registry"])) throw new Error(message);
  const active = activeOf(result.active, message);
  let registry: ReleaseRegistry;
  try {
    registry = decodeReleaseRegistry(new TextEncoder().encode(JSON.stringify(result.registry)));
  } catch {
    throw new Error(message);
  }
  if (registry.repository.commit !== active.commit) throw new Error(message);
  return { active, registry };
};

export const releaseActivationResultOf = (
  value: unknown,
): { readonly changed: boolean; readonly active: ActiveRelease } => {
  const message = "invalid release activation response";
  const result = recordOf(value, message);
  if (!exactKeys(result, ["active", "changed"]) || typeof result.changed !== "boolean") {
    throw new Error(message);
  }
  return { changed: result.changed, active: activeOf(result.active, message) };
};
