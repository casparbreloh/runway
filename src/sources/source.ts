import type { Effect } from "effect";

import type { AgentName, JobResult, JobSpec, ValidationError } from "../domain.ts";
import type { Store } from "../store.ts";

export interface SourceConfig {
  readonly workspace?: string;
  readonly defaultAgent: AgentName;
  readonly defaultBase: string;
  readonly defaultRepo?: string;
  readonly triggerState?: string;
  readonly triggerComment?: string;
}

export interface ReportOptions {
  readonly linearApiKey?: string;
}

export interface Source {
  readonly name: string;
  readonly toJobSpec: (
    input: unknown,
    config: SourceConfig,
  ) => Effect.Effect<JobSpec | null, ValidationError, Store>;
  readonly report: (
    result: JobResult,
    ref: string | undefined,
    opts: ReportOptions,
  ) => Effect.Effect<void>;
}
