export const SANDBOX_BINDING = "RunwaySandbox";
export const SANDBOX_CLASS = "Sandbox";
export const SANDBOX_IMAGE = "docker.io/cloudflare/sandbox:0.12.3";
export const SANDBOX_MIGRATION_TAG = "runway-sandbox-v1";

export const RUNNER_CONTAINER = {
  class_name: SANDBOX_CLASS,
  image: SANDBOX_IMAGE,
  instance_type: "lite",
} as const;

export const RUNNER_APPLICATION = {
  scheduling_policy: "default",
  configuration: { image: RUNNER_CONTAINER.image, instance_type: RUNNER_CONTAINER.instance_type },
  instances: 0,
  max_instances: 20,
  constraints: { tiers: [1, 2] },
  rollout_active_grace_period: 0,
} as const;
