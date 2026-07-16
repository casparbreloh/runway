import { WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";
export { DynamicWorkflowBinding } from "@cloudflare/dynamic-workflows";

import { createDynamicWorkflow } from "../src/host-runtime.ts";
import type { RepositorySource } from "../src/repository-source.ts";

interface RepositoryProbeProps {
  readonly repository: RepositorySource;
  readonly secretNames: ReadonlyArray<string>;
}

export class RunwayRunnerBinding extends WorkerEntrypoint<Cloudflare.Env, RepositoryProbeProps> {
  async reportRunLifecycle(): Promise<boolean> {
    return true;
  }

  async secrets(): Promise<Readonly<Record<string, string>>> {
    return this.#values();
  }

  async captureSecrets(): Promise<string> {
    return "repository-probe";
  }

  async restoreSecrets(): Promise<Readonly<Record<string, string>>> {
    return this.#values();
  }

  async exec(): Promise<never> {
    throw new Error("repository probe does not execute commands");
  }

  async destroy(): Promise<void> {}

  #values(): Readonly<Record<string, string>> {
    return Object.fromEntries(
      this.ctx.props.secretNames.map((name) => [
        name,
        name === "API_KEY" ? JSON.stringify(this.ctx.props.repository) : "test-secret",
      ]),
    );
  }
}

export const RepositoryProbeDynamic: typeof WorkflowEntrypoint<unknown, unknown> =
  createDynamicWorkflow({
    scriptName: "generated-runway-host",
    deploymentId: "repository-probe-deployment",
    secretSnapshotKey: "RUNWAY_SECRET_SNAPSHOT_KEY",
    routes: [],
  });
