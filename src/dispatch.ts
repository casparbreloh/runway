import { Effect } from "effect";

import { type AgentSecrets, withAgentAuth } from "./agent-auth.ts";
import { agents } from "./agents/index.ts";
import { type JobResult, type JobSpec, jobResult } from "./domain.ts";
import { Sandbox } from "./sandbox.ts";
import { Store } from "./store.ts";

export type DispatchSecrets = AgentSecrets;

export const dispatchJob = (
  spec: JobSpec,
  secrets: DispatchSecrets,
): Effect.Effect<JobResult, never, Sandbox | Store> =>
  withAgentAuth(
    spec.agent,
    secrets,
    Effect.gen(function* () {
      const store = yield* Store;
      const result = yield* agents[spec.agent].run(spec);
      yield* store.putJob(result).pipe(Effect.orElseSucceed(() => undefined));
      return result;
    }),
  ).pipe(
    Effect.catchTag("AuthError", (e) =>
      Effect.succeed(jobResult(spec, "failure", { error: e.reason })),
    ),
  );
