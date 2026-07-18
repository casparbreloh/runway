import { WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";
export { DynamicWorkflowBinding } from "@cloudflare/dynamic-workflows";

import { createDynamicWorkflow } from "../../src/internal/runtime/host.ts";
import type { RepositorySource } from "../../src/internal/source/repository.ts";
import type { PreparedSource, SourceIdentity } from "../../src/internal/source/source.ts";
import type { TerminalRecord } from "../../src/internal/terminal.ts";

interface RepositoryProbeProps {
  readonly repository: RepositorySource;
  readonly secretNames: ReadonlyArray<string>;
}

export class RunwaySandboxBinding extends WorkerEntrypoint<Cloudflare.Env, RepositoryProbeProps> {
  async startRun(): Promise<boolean> {
    return true;
  }

  async terminal(runId: string) {
    const source = await this.source();
    return {
      accountId: "repository-probe-account",
      repositoryId: source.repositoryId,
      workflowId: "repository-probe",
      runId,
      trustId: source.repositoryId,
      generation: 1,
    };
  }

  async publishTerminal(): Promise<void> {}

  async claimTerminal(_runId: string, candidate: TerminalRecord): Promise<TerminalRecord> {
    return candidate;
  }

  async readTerminal(): Promise<undefined> {
    return undefined;
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

  async source(): Promise<SourceIdentity> {
    const repository = this.ctx.props.repository;
    return {
      repositoryId:
        repository.authentication.type === "github"
          ? `github:${repository.authentication.repository.id}`
          : `remote:${repository.remote}`,
      remote: repository.remote,
      revision: repository.commit,
    };
  }

  async prepareSource(): Promise<PreparedSource> {
    const source = await this.source();
    return {
      placement: "repository-probe-placement",
      result: { revision: source.revision, state: "prepared", bytes: 0 },
    };
  }

  async execute(): Promise<never> {
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
    accountId: "repository-probe-account",
    cacheBucket: "runway-repository-probe-account",
    imageDigest: `sha256:${"1".repeat(64)}`,
    scriptName: "generated-runway-host",
    deploymentId: "repository-probe-deployment",
    secretSnapshotKey: "RUNWAY_SECRET_SNAPSHOT_KEY",
    routes: [],
  });
