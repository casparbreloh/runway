import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { createRouter } from "./router.ts";
import { makeRun, secretsOf } from "./run.ts";
import type { RunOperations } from "./run.ts";
import type { RuntimeBinding } from "./runtime-binding.ts";
import { ExecTimeoutError, RunLostError, Sandbox } from "./sandbox.ts";
import { source } from "./source.ts";
import type { SourceIdentity } from "./source.ts";
import { Terminal, TerminalError } from "./terminal.ts";
import type { Finalization, TerminalRecord, TerminalState } from "./terminal.ts";
import type { WorkflowDefinition } from "./types.ts";
import { RUNTIME_BINDING } from "./worker-contract.ts";

const SECRET_SNAPSHOT_STEP = "runway:secret-snapshot";
const TERMINAL_START_STEP = "runway:terminal-start";
const TERMINAL_CLAIM_STEP = "runway:terminal-claim";
const TERMINAL_PUBLISH_STEP = "runway:terminal-publish";

interface WorkflowBinding {
  create(opts: { params: unknown }): Promise<{ id: string | Promise<string> }>;
}

type DynamicWorkerEnv = Record<string, unknown> & {
  WORKFLOWS?: WorkflowBinding;
  [RUNTIME_BINDING]?: RuntimeBinding;
};

interface RunRuntime {
  readonly operations: RunOperations;
  cleanup(): Promise<void>;
  finish(finalization: Finalization): Promise<void>;
}

const makeRunRuntime = (
  step: WorkflowStep,
  binding: RuntimeBinding,
  runId: string,
  secrets: Readonly<Record<string, string>>,
  identity: SourceIdentity,
  terminal: Terminal,
): RunRuntime => {
  const exactSource = source(identity, {
    prepare: async (requested, options) =>
      await binding.prepareSource({ runId, source: requested, secrets, ...options }),
  });
  const sandbox = new Sandbox({
    runId,
    secrets,
    source: exactSource,
    placement: {
      exec: async ({
        step: durableStep,
        source: prepared,
        command,
        secrets: _secrets,
        ...rest
      }) => {
        try {
          return await binding.execute({
            ...rest,
            step: durableStep,
            source: prepared,
            options: command,
            secrets,
          });
        } catch (error) {
          if (
            error instanceof RunLostError ||
            (error instanceof Error && error.name === "RunLostError")
          ) {
            throw new RunLostError(error.message);
          }
          if (
            error instanceof ExecTimeoutError ||
            (error instanceof Error && error.name === "ExecTimeoutError")
          ) {
            throw new ExecTimeoutError(error.message);
          }
          throw error;
        }
      },
      destroy: async () => await binding.destroy(runId, secrets),
    },
    terminal,
  });
  return {
    operations: {
      do: <T>(id: string, fn: () => Promise<T>): Promise<T> =>
        step.do(id, fn as () => Promise<never>) as Promise<T>,
      exec: (id, command) =>
        sandbox.exec(
          {
            id,
            run: async (digest, work, rollback) => {
              let executed = false;
              const recorded: unknown = await step.do(
                id,
                { retries: { limit: 5, delay: 0 } },
                async (ctx) => {
                  executed = true;
                  try {
                    return {
                      digest,
                      result: await work({
                        count: ctx.step.count,
                        attempt: ctx.attempt,
                      }),
                    } as never;
                  } catch (error) {
                    if (error instanceof RunLostError) {
                      return {
                        digest,
                        lost: { message: error.message, attempt: ctx.attempt },
                      } as never;
                    }
                    if (error instanceof ExecTimeoutError) {
                      return {
                        digest,
                        timeout: { message: error.message, attempt: ctx.attempt },
                      } as never;
                    }
                    throw error;
                  }
                },
                { rollback },
              );
              if (
                !recorded ||
                typeof recorded !== "object" ||
                !("digest" in recorded) ||
                recorded.digest !== digest ||
                ["result", "lost", "timeout"].filter((field) => field in recorded).length !== 1
              ) {
                throw new RunLostError("run continuity was lost because command options changed");
              }
              const evidence = recorded as {
                readonly digest: string;
                readonly result?: never;
                readonly lost?: { readonly message: string; readonly attempt: number };
                readonly timeout?: { readonly message: string; readonly attempt: number };
              };
              const terminal = evidence.lost
                ? { lost: evidence.lost }
                : evidence.timeout
                  ? { timeout: evidence.timeout }
                  : { result: evidence.result as never };
              return {
                digest: evidence.digest,
                ...terminal,
                callback: executed ? "executed" : "recorded",
              };
            },
          },
          command,
        ),
      sleep: (id: string, durationMs: number): Promise<void> => step.sleep(id, durationMs),
    },
    cleanup: () => sandbox.cleanup(),
    finish: (finalization) => sandbox.finish(finalization),
  };
};

const makeTerminal = async (
  step: WorkflowStep,
  binding: RuntimeBinding,
  runId: string,
): Promise<Terminal> => {
  let winner: TerminalRecord | undefined;
  const state: TerminalState = {
    claim: async (candidate) => {
      winner = (await step.do(
        TERMINAL_CLAIM_STEP,
        async () => (await binding.claimTerminal(runId, candidate)) as never,
      )) as TerminalRecord;
      return winner;
    },
    read: async () => (await binding.readTerminal(runId)) ?? winner,
  };
  return new Terminal(await binding.terminal(runId), state, async (finalization) => {
    await step.do(TERMINAL_PUBLISH_STEP, async () => {
      await binding.publishTerminal(runId, finalization);
    });
  });
};

export const toEntrypoint = (
  def: WorkflowDefinition,
): typeof WorkflowEntrypoint<unknown, unknown> =>
  class extends WorkflowEntrypoint<unknown, unknown> {
    override async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<unknown> {
      const binding = (this.env as DynamicWorkerEnv)[RUNTIME_BINDING];
      if (!binding) throw new Error(`missing runtime binding: ${RUNTIME_BINDING}`);
      const terminal = await makeTerminal(step, binding, event.instanceId);
      const started = (await step.do(
        TERMINAL_START_STEP,
        async () => (await binding.startRun(event.instanceId)) as never,
      )) as boolean;
      if (!started) return undefined;
      let secrets: Readonly<Record<string, string>>;
      try {
        const snapshot = await step.do(
          SECRET_SNAPSHOT_STEP,
          async () => (await binding.captureSecrets(event.instanceId)) as never,
        );
        secrets = secretsOf(def.secrets, await binding.restoreSecrets(event.instanceId, snapshot));
      } catch (error) {
        await terminal.publish(await terminal.claim("failure"));
        throw error;
      }
      const runtime = makeRunRuntime(
        step,
        binding,
        event.instanceId,
        secrets,
        await binding.source(),
        terminal,
      );
      let result: unknown;
      let failed = false;
      let failure: unknown;
      try {
        result = await def.run(
          makeRun(runtime.operations, {
            runId: event.instanceId,
            secrets,
          }),
          event.payload,
        );
      } catch (error) {
        failed = true;
        failure = error;
      }
      let cleanupFailed = false;
      if (!failed) {
        try {
          await runtime.cleanup();
        } catch (error) {
          failed = true;
          failure = error;
          cleanupFailed = true;
        }
      }
      const finalization = await terminal.claim(failed ? "failure" : "success");
      if (cleanupFailed) {
        await terminal.publish(finalization);
        throw failure;
      }
      let finishFailure: unknown;
      let finishFailed = false;
      try {
        await runtime.finish(finalization);
      } catch (error) {
        finishFailed = true;
        finishFailure = error;
      }
      await terminal.publish(finalization);
      if (finishFailed) throw finishFailure;
      if (finalization.outcome !== "success") {
        if (failed) throw failure;
        throw new TerminalError(`run was already finalized as ${finalization.outcome}`);
      }
      return result;
    }
  };

export const createWorkflowWorker = (
  def: WorkflowDefinition,
): {
  fetch(req: Request, env: unknown): Promise<Response>;
} => ({
  async fetch(req, env) {
    const dynamicEnv = env as DynamicWorkerEnv;
    const workflow = dynamicEnv.WORKFLOWS;
    if (!workflow) return new Response("no binding: WORKFLOWS", { status: 500 });
    const binding = dynamicEnv[RUNTIME_BINDING];
    if (!binding) {
      return new Response(`missing runtime binding: ${RUNTIME_BINDING}`, { status: 500 });
    }
    const secrets = secretsOf(def.secrets, await binding.secrets());
    const router = createRouter([{ id: def.id, trigger: def.trigger }], {
      async start(_entry, event) {
        const instance = await workflow.create({ params: event });
        return { id: await instance.id };
      },
    });
    const routerEnv = { ...secrets };
    if (req.headers.get("x-runway-trigger") === "scheduled") {
      const event = (await req.json()) as { cron: string; scheduledTime: number };
      await router.scheduled(event, routerEnv);
      return new Response(null, { status: 204 });
    }
    return await router.fetch(req, routerEnv);
  },
});
