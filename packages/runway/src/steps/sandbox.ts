import type { SandboxArgs, SandboxHandle } from "./types.ts";

// Resolve the sandbox id for this run. The container itself is created lazily on the first
// shell/agent exec; this just fixes a stable, replay-safe id derived from the workflow
// instance (so re-runs reuse the same container rather than orphaning a new one).
export const runSandbox = (args: SandboxArgs, instanceId: string): SandboxHandle => ({
  id: args.id ?? `runway-${instanceId}`,
});
