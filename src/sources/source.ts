import type { Effect } from "effect";

import type { AgentName, JobSpec, ValidationError } from "../domain.ts";
import type { Store } from "../store.ts";

export interface SourceConfig {
  readonly workspace?: string;
  readonly defaultAgent: AgentName;
  readonly defaultBase: string;
  readonly defaultRepo?: string;
  readonly triggerState?: string;
  readonly triggerComment?: string;
}

export interface Source {
  readonly name: string;
  readonly toJobSpec: (
    input: unknown,
    config: SourceConfig,
  ) => Effect.Effect<JobSpec | null, ValidationError, Store>;
}
