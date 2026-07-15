import type { CloudflareApi } from "./cloudflare-api.ts";
import type { PreparedDeployment } from "./deploy-build.ts";
import { workflowArtifactKey } from "./workflow-artifact.ts";

const isStatus = (error: unknown, status: number): boolean =>
  !!error && typeof error === "object" && "status" in error && error.status === status;

export const artifactBucketName = (accountId: string): string => `runway-${accountId}`;

export const ensureArtifactBucket = async (
  cf: Pick<CloudflareApi, "r2">,
  accountId: string,
  bucketName: string,
): Promise<boolean> => {
  try {
    await cf.r2.buckets.get(bucketName, { account_id: accountId });
    return false;
  } catch (error) {
    if (!isStatus(error, 404)) throw error;
    await cf.r2.buckets.create({ account_id: accountId, name: bucketName });
    return true;
  }
};

export const uploadWorkflowArtifacts = async (
  cf: CloudflareApi,
  accountId: string,
  deployment: Pick<PreparedDeployment, "artifacts">,
): Promise<string> => {
  const bucketName = artifactBucketName(accountId);
  try {
    await ensureArtifactBucket(cf, accountId, bucketName);
    for (const artifact of deployment.artifacts) {
      await cf.r2.buckets.objects.upload(
        bucketName,
        workflowArtifactKey(artifact.artifactVersion),
        artifact.contents,
        { account_id: accountId },
      );
    }
  } catch (error) {
    if (!isStatus(error, 403)) throw error;
    throw new Error(
      "Cloudflare API token needs Workers R2 Storage Write permission to persist Runway workflow artifacts",
      { cause: error },
    );
  }
  return bucketName;
};
