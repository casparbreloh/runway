export const COMPATIBILITY_DATE = "2026-06-06";
export const WORKFLOW_BINDING = "WORKFLOWS";
export const LOADER_BINDING = "LOADER";
export const ARTIFACT_BUCKET_BINDING = "RUNWAY_ARTIFACTS";
export const HOST_CAPABILITY_BINDING = "RUNWAY_HOST";
export const SECRET_SNAPSHOT_KEY_BINDING = "RUNWAY_SECRET_SNAPSHOT_KEY";
export const SECRET_SNAPSHOT_KEY_PREFIX = `${SECRET_SNAPSHOT_KEY_BINDING}_`;
export const secretSnapshotBackupBinding = (deploymentId: string): string =>
  `${SECRET_SNAPSHOT_KEY_PREFIX}${deploymentId.replaceAll("-", "")}`;
export const isSecretSnapshotKeyBinding = (name: string): boolean =>
  name === SECRET_SNAPSHOT_KEY_BINDING || name.startsWith(SECRET_SNAPSHOT_KEY_PREFIX);
export const DYNAMIC_WORKFLOW_CLASS = "DynamicWorkflow";
export const RUNWAY_WORKFLOW_CLASS = "RunwayWorkflow";
