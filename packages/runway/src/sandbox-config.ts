export const SANDBOX_BINDING = "RunwaySandbox";
export const SANDBOX_CLASS = "Sandbox";
export const SANDBOX_IMAGE = "docker.io/cloudflare/sandbox:0.12.3";
export const SANDBOX_MIGRATION_TAG = "runway-sandbox-v1";
export const GITHUB_COORDINATOR_BINDING = "RUNWAY_GITHUB_COORDINATOR";
export const GITHUB_COORDINATOR_CLASS = "RunwayGitHubCoordinator";
export const GITHUB_COORDINATOR_MIGRATION_TAG = "runway-github-coordinator-v2";

export const SANDBOX_CONTAINER = {
  class_name: SANDBOX_CLASS,
  image: SANDBOX_IMAGE,
  instance_type: "standard-1",
} as const;

export const SANDBOX_APPLICATION = {
  scheduling_policy: "default",
  configuration: { image: SANDBOX_CONTAINER.image, instance_type: SANDBOX_CONTAINER.instance_type },
  instances: 0,
  max_instances: 20,
  constraints: { tiers: [1, 2] },
  rollout_active_grace_period: 0,
} as const;
