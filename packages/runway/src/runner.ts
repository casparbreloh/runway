import type { ExecResult } from "./run.ts";
import type { NormalizedExecOptions } from "./sandbox.ts";
import type { SourceIdentity, SourceResult } from "./source.ts";

export interface RunnerBridge {
  prepare(request: {
    readonly runId: string;
    readonly secrets: ReadonlyArray<string>;
  }): Promise<SourceResult>;
  exec(request: {
    readonly runId: string;
    readonly step: { readonly id: string; readonly count: number; readonly attempt: number };
    readonly options: NormalizedExecOptions;
    readonly secrets: ReadonlyArray<string>;
    readonly source: SourceResult;
  }): Promise<ExecResult>;
  destroy(runId: string, secrets: ReadonlyArray<string>): Promise<void>;
}

export interface HostCapability {
  reportRunLifecycle(runId: string, state: RunLifecycleState): Promise<boolean>;
  secrets(): Promise<Readonly<Record<string, string>>>;
  captureSecrets(runId: string): Promise<string>;
  restoreSecrets(runId: string, snapshot: string): Promise<Readonly<Record<string, string>>>;
  source(): Promise<SourceIdentity>;
  prepareSource(request: {
    readonly runId: string;
    readonly source: SourceIdentity;
    readonly secrets: Readonly<Record<string, string>>;
  }): Promise<SourceResult>;
  exec(
    request: Omit<Parameters<RunnerBridge["exec"]>[0], "secrets"> & {
      readonly secrets: Readonly<Record<string, string>>;
    },
  ): Promise<ExecResult>;
  destroy(runId: string, secrets: Readonly<Record<string, string>>): Promise<void>;
}

export type RunLifecycleState = "in_progress" | "success" | "failure";
