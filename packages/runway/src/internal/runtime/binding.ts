import type { ExecResult } from "../../step.ts";
import type { CacheTreeDeclaration } from "../cache/cache.ts";
import type { PendingCache, PreparedCache } from "../cache/cache.ts";
import type { MeterReport } from "../meter.ts";
import type { CacheRecord, NormalizedExecOptions } from "../sandbox/sandbox.ts";
import type { PreparedSource, SourceIdentity } from "../source/source.ts";
import type { Finalization, TerminalIdentity, TerminalRecord } from "../terminal.ts";
import type { FailureDiagnostic } from "./diagnostic.ts";

export interface RuntimeBinding {
  startRun(runId: string): Promise<boolean>;
  reportMeter(runId: string, report: MeterReport): Promise<void>;
  terminal(runId: string): Promise<TerminalIdentity>;
  claimTerminal(runId: string, candidate: TerminalRecord): Promise<TerminalRecord>;
  readTerminal(runId: string): Promise<TerminalRecord | undefined>;
  publishTerminal(
    runId: string,
    finalization: Finalization,
    diagnostic: FailureDiagnostic | null,
  ): Promise<void>;
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
    readonly declaration: CacheTreeDeclaration;
    readonly secrets: Readonly<Record<string, string>>;
    readonly source: PreparedSource;
  }): Promise<CacheRecord>;
  discardCaches(request: {
    readonly runId: string;
    readonly paths: readonly string[];
    readonly secrets: Readonly<Record<string, string>>;
  }): Promise<void>;
  quiesce(runId: string, secrets: Readonly<Record<string, string>>): Promise<void>;
  prepareCaches(request: {
    readonly runId: string;
    readonly pending: readonly PendingCache[];
    readonly secrets: Readonly<Record<string, string>>;
  }): Promise<readonly PreparedCache[]>;
  publishCaches(request: {
    readonly runId: string;
    readonly finalization: Finalization;
    readonly prepared: readonly PreparedCache[];
    readonly secrets: Readonly<Record<string, string>>;
  }): Promise<void>;
  execute(request: {
    readonly runId: string;
    readonly step: { readonly id: string; readonly count: number; readonly attempt: number };
    readonly options: NormalizedExecOptions;
    readonly secrets: Readonly<Record<string, string>>;
    readonly source: PreparedSource;
  }): Promise<ExecResult>;
  destroy(runId: string, secrets: Readonly<Record<string, string>>): Promise<void>;
}
