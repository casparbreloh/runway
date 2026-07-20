export const SANDBOX_BINDING = "RunwaySandbox";
export const SANDBOX_CLASS = "Sandbox";
export const SANDBOX_IMAGE =
  "docker.io/cloudflare/sandbox@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042";
export const GITHUB_COORDINATOR_BINDING = "RUNWAY_GITHUB_COORDINATOR";
export const GITHUB_COORDINATOR_CLASS = "RunwayGitHubCoordinator";
export const CACHE_SCHEMA = 2;
export const SANDBOX_RUNNER_ABI = "runway-sandbox-v2";

export const SANDBOX_CONTAINER = {
  class_name: SANDBOX_CLASS,
  image: SANDBOX_IMAGE,
  instance_type: "standard-4",
} as const;
export const SANDBOX_IMAGE_DIGEST = SANDBOX_IMAGE.slice(SANDBOX_IMAGE.indexOf("@") + 1);

export const CACHE_LIMITS = {
  maxBytes: 1024 * 1024 * 1024,
  helperDurationMs: 180_000,
} as const;

export const SANDBOX_APPLICATION = {
  scheduling_policy: "default",
  configuration: { image: SANDBOX_CONTAINER.image, instance_type: SANDBOX_CONTAINER.instance_type },
  instances: 0,
  max_instances: 20,
  constraints: { tiers: [1, 2] },
  rollout_active_grace_period: 0,
} as const;
