import type { CacheDeclaration, CacheResult, ExecResult } from "./run.ts";
import type { NormalizedExecOptions } from "./sandbox.ts";
import type { PreparedSource, SourceIdentity } from "./source.ts";
import type { Finalization, TerminalIdentity, TerminalRecord } from "./terminal.ts";

export interface RuntimeBinding {
  startRun(runId: string): Promise<boolean>;
  terminal(runId: string): Promise<TerminalIdentity>;
  claimTerminal(runId: string, candidate: TerminalRecord): Promise<TerminalRecord>;
  readTerminal(runId: string): Promise<TerminalRecord | undefined>;
  publishTerminal(runId: string, finalization: Finalization): Promise<void>;
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
  restoreCache(request: {
    readonly runId: string;
    readonly id: string;
    readonly declaration: CacheDeclaration;
    readonly secrets: Readonly<Record<string, string>>;
    readonly source: PreparedSource;
  }): Promise<CacheResult>;
  execute(request: {
    readonly runId: string;
    readonly step: { readonly id: string; readonly count: number; readonly attempt: number };
    readonly options: NormalizedExecOptions;
    readonly secrets: Readonly<Record<string, string>>;
    readonly source: PreparedSource;
  }): Promise<ExecResult>;
  destroy(runId: string, secrets: Readonly<Record<string, string>>): Promise<void>;
}
