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
      command: "mise install && mise exec aube@1.29.1 -- aube install --frozen-lockfile",
      cache: {
        inputs: [
          "package.json",
          "packages/runway/package.json",
          "mise.toml",
          "mise.lock",
          "aube-workspace.yaml",
          "aube-lock.yaml",
        ],
      },
    });

    await Promise.all([
      deps.runner({ name: "format-check", command: "mise run format-check" }),
      deps.runner({ name: "lint", command: "mise run lint" }),
      deps.runner({ name: "typecheck", command: "mise run typecheck" }),
      deps.runner({ name: "fallow", command: "mise run fallow" }),
      deps.runner({
        name: "test",
        command: "mise run test",
        env: { VITEST_MAX_WORKERS: "1" },
      }),
    ]);
  }
}
