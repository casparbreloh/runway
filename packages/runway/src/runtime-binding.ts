import type { ExecResult } from "./run.ts";
import type { NormalizedExecOptions } from "./sandbox.ts";
import type { PreparedSource, SourceIdentity } from "./source.ts";

export interface RuntimeBinding {
  reportRunLifecycle(runId: string, state: RunLifecycleState): Promise<boolean>;
  secrets(): Promise<Readonly<Record<string, string>>>;
  captureSecrets(runId: string): Promise<string>;
  restoreSecrets(runId: string, snapshot: string): Promise<Readonly<Record<string, string>>>;
  source(): Promise<SourceIdentity>;
  prepareSource(request: {
    readonly runId: string;
    readonly source: SourceIdentity;
    readonly secrets: Readonly<Record<string, string>>;
    readonly allowReconstruct: boolean;
  }): Promise<PreparedSource>;
  execute(request: {
    readonly runId: string;
    readonly step: { readonly id: string; readonly count: number; readonly attempt: number };
    readonly options: NormalizedExecOptions;
    readonly secrets: Readonly<Record<string, string>>;
    readonly source: PreparedSource;
  }): Promise<ExecResult>;
  destroy(runId: string, secrets: Readonly<Record<string, string>>): Promise<void>;
}

export type RunLifecycleState = "in_progress" | "success" | "failure";
