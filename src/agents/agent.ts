import type { Effect } from "effect";

import type { JobResult, JobSpec } from "../domain.ts";
import type { Sandbox } from "../sandbox.ts";

export interface RunOptions {
  readonly pr?: boolean;
}

export interface Agent {
  readonly name: string;
  readonly container: string;
  readonly authProvider: string;
  readonly run: (spec: JobSpec, opts?: RunOptions) => Effect.Effect<JobResult, never, Sandbox>;
}
