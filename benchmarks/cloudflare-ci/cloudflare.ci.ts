import { CIWorkflow } from "@cloudflare/ci";
import type { CiContext, CiParams, CloudflareArtifacts } from "@cloudflare/ci";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { Bindings } from "./env";

export class CI extends CIWorkflow<CloudflareArtifacts, Bindings> {
  protected async pipeline(
    _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    _step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const deps = await ci.runner({
      name: "install",
      command: "mise install && aube install --frozen-lockfile",
      cache: {
        inputs: ["mise.toml", "mise.lock", "aube-workspace.yaml", "aube-lock.yaml"],
      },
    });

    await Promise.all([
      deps.runner({
        name: "check",
        command: "mise run format-check && mise run lint && mise run typecheck && mise run fallow",
      }),
      deps.runner({
        name: "test",
        command: "mise run test",
        env: { VITEST_MAX_WORKERS: "1" },
      }),
    ]);
  }
}
