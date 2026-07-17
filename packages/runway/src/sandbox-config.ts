export const SANDBOX_BINDING = "RunwaySandbox";
export const SANDBOX_CLASS = "Sandbox";
export const SANDBOX_IMAGE =
  "docker.io/cloudflare/sandbox@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042";
export const GITHUB_COORDINATOR_BINDING = "RUNWAY_GITHUB_COORDINATOR";
export const GITHUB_COORDINATOR_CLASS = "RunwayGitHubCoordinator";
export const CACHE_SCHEMA = 2;
export const SANDBOX_RUNNER_ABI = "runway-sandbox-v2";

export const SANDBOX_INSTANCE_TYPES = {
  lite: { vcpu: 0.0625, memoryMib: 256, diskMb: 2_000 },
  basic: { vcpu: 0.25, memoryMib: 1_024, diskMb: 4_000 },
  "standard-1": { vcpu: 0.5, memoryMib: 4_096, diskMb: 8_000 },
  "standard-2": { vcpu: 1, memoryMib: 6_144, diskMb: 12_000 },
  "standard-3": { vcpu: 2, memoryMib: 8_192, diskMb: 16_000 },
  "standard-4": { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 },
} as const;

export const SANDBOX_CONTAINER = {
  class_name: SANDBOX_CLASS,
  image: SANDBOX_IMAGE,
  instance_type: "standard-4",
} as const;

const capacity = SANDBOX_INSTANCE_TYPES[SANDBOX_CONTAINER.instance_type];

export const SANDBOX_CAPACITY = {
  vcpu: capacity.vcpu,
  memoryGib: capacity.memoryMib / 1024,
  diskGb: capacity.diskMb / 1000,
} as const;

export const CACHE_LIMITS = {
  maxBytes: 1024 * 1024 * 1024,
  helperDurationMs: 180_000,
  transferDurationMs: 15 * 60_000,
  storageHorizonMs: 30 * 24 * 60 * 60 * 1_000,
  saveClassAOperations: 9,
  saveClassBOperations: 10,
  restoreClassAOperations: 0,
  restoreClassBOperations: 4,
  saveWorkflowSteps: 3,
  restoreWorkflowSteps: 1,
} as const;

export const SANDBOX_APPLICATION = {
  scheduling_policy: "default",
  configuration: { image: SANDBOX_CONTAINER.image, instance_type: SANDBOX_CONTAINER.instance_type },
  instances: 0,
  max_instances: 20,
  constraints: { tiers: [1, 2] },
  rollout_active_grace_period: 0,
} as const;
