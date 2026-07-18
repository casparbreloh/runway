import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { PreparedCache } from "./internal/cache/cache.ts";
import { normalizedCacheTarget } from "./internal/cache/path.ts";
import { CLOUDFLARE_PRICE_TABLE, Meter } from "./internal/meter.ts";
import type { RuntimeBinding } from "./internal/runtime/binding.ts";
import { RUNTIME_BINDING } from "./internal/runtime/contract.ts";
import { failureDiagnosticOf } from "./internal/runtime/diagnostic.ts";
import type { FailureDiagnostic } from "./internal/runtime/diagnostic.ts";
import { createRouter } from "./internal/runtime/router.ts";
import { SANDBOX_CAPACITY } from "./internal/sandbox/config.ts";
import { ExecTimeoutError, RunLostError, Sandbox } from "./internal/sandbox/sandbox.ts";
import { source } from "./internal/source/source.ts";
import type { SourceIdentity } from "./internal/source/source.ts";
import { Terminal, TerminalError } from "./internal/terminal.ts";
import type { Finalization, TerminalRecord, TerminalState } from "./internal/terminal.ts";
import { withTools } from "./internal/tool/execution.ts";
import { makeStep, secretsOf } from "./step.ts";
import { validateCacheDeclaration, type Step } from "./step.ts";
import type { WorkflowDefinition } from "./workflow.ts";

const SECRET_SNAPSHOT_STEP = "runway:secret-snapshot";
const CACHE_PREPARE_STEP = "runway:cache-prepare";
const CACHE_PUBLISH_STEP = "runway:cache-publish";
const TERMINAL_START_STEP = "runway:terminal-start";
const TERMINAL_CLAIM_STEP = "runway:terminal-claim";
const TERMINAL_PUBLISH_STEP = "runway:terminal-publish";

const measuredWorkflowStep = async <T>(meter: Meter, work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } finally {
    try {
      meter.usage("workflow", "step", 1, "derived");
    } catch {}
  }
};

const cachePublicationIdentity = async (
  finalization: Finalization,
  prepared: readonly PreparedCache[],
): Promise<string> => {
  const fields: string[] = [
    "cache-publication",
    finalization.claimId,
    finalization.outcome,
    String(prepared.length),
  ];
  for (const entry of prepared) {
    if (entry.state !== "ready") throw new Error("invalid durable cache publication");
    const { pending, object } = entry;
    const key = pending.declaration.key;
    fields.push(
      "ready",
      pending.id,
      pending.target,
      String(pending.schema),
      typeof key === "string" ? "string" : "files",
      ...(typeof key === "string"
        ? [key]
        : [key.prefix ?? "", String(key.files.length), ...key.files]),
      String(pending.declaration.restoreKeys?.length ?? 0),
      ...(pending.declaration.restoreKeys ?? []),
      pending.declaration.path,
      pending.declaration.budget?.maxBytes === undefined
        ? "maxBytes:unset"
        : `maxBytes:${pending.declaration.budget.maxBytes}`,
      pending.declaration.budget?.maxDurationMs === undefined
        ? "maxDurationMs:unset"
        : `maxDurationMs:${pending.declaration.budget.maxDurationMs}`,
      pending.declaration.budget?.maxEstimatedCostUsd === undefined
        ? "maxEstimatedCostUsd:unset"
        : `maxEstimatedCostUsd:${pending.declaration.budget.maxEstimatedCostUsd}`,
      pending.revision.cacheIdDigest,
      pending.revision.declarationDigest,
      pending.revision.etag ?? "etag:missing",
      String(pending.revision.generation),
      pending.revision.key,
      pending.revision.keyDigest,
      pending.revision.platformDigest,
      pending.revision.ref,
      pending.revision.repositoryDigest,
      String(pending.revision.schema),
      pending.revision.scopeDigest,
      object.archiveDigest,
      String(object.archiveBytes),
      object.digest,
      object.key,
      object.manifest,
    );
  }
  const encoder = new TextEncoder();
  const chunks = fields.map((field) => encoder.encode(field));
  const bytes = new Uint8Array(chunks.reduce((sum, field) => sum + field.byteLength + 8, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const field of chunks) {
    view.setBigUint64(offset, BigInt(field.byteLength));
    offset += 8;
    bytes.set(field, offset);
    offset += field.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

interface WorkflowBinding {
  create(opts: { params: unknown }): Promise<{ id: string | Promise<string> }>;
}

type DynamicWorkerEnv = Record<string, unknown> & {
  WORKFLOWS?: WorkflowBinding;
  [RUNTIME_BINDING]?: RuntimeBinding;
};

interface StepRuntime extends Pick<Step, "do" | "exec" | "cache" | "sleep"> {
  cleanup(): Promise<void>;
  finish(finalization: Finalization): Promise<void>;
}

const cacheTreeId = async (id: string, index: number, path: string): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify([id, index, path]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `runway:cache-tree:${hex}`;
};

const makeStepRuntime = (
  step: WorkflowStep,
  binding: RuntimeBinding,
  runId: string,
  secrets: Readonly<Record<string, string>>,
  identity: SourceIdentity,
  terminal: Terminal,
  meter: Meter,
): StepRuntime => {
  let preparedCaches: readonly PreparedCache[] = [];
  const exactSource = source(identity, {
    prepare: async (requested, options) =>
      await binding.prepareSource({ runId, source: requested, secrets, ...options }),
  });
  const sandbox = new Sandbox({
    runId,
    secrets,
    source: exactSource,
    placement: {
      cache: async ({ secrets: _secrets, ...request }) =>
        await binding.restoreCache({ ...request, secrets }),
      quiesce: async () => await binding.quiesce(runId, secrets),
      prepareCaches: async ({ secrets: _secrets, ...request }) =>
        await binding.prepareCaches({ ...request, secrets }),
      publishCaches: async ({ secrets: _secrets, ...request }) =>
        await binding.publishCaches({ ...request, secrets }),
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
    meter,
  });
  const operations: Pick<Step, "do" | "exec" | "cache" | "sleep"> = {
    do: <T>(id: string, work: () => T | Promise<T>): Promise<T> =>
      measuredWorkflowStep(
        meter,
        () => step.do(id, async () => (await work()) as never) as Promise<T>,
      ),
    exec: (id, command) =>
      sandbox.exec(
        {
          id,
          run: async (digest, work, rollback) => {
            let executed = false;
            const recorded: unknown = await measuredWorkflowStep(meter, async () =>
              step.do(
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
              ),
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
    cache: async (id, declaration) => {
      validateCacheDeclaration(declaration);
      const results = [];
      for (const [index, path] of declaration.paths.entries()) {
        const treeId = declaration.paths.length === 1 ? id : await cacheTreeId(id, index, path);
        results.push({
          path,
          result: await sandbox.cache(
            {
              id: treeId,
              run: async (digest, work) => {
                const recorded: unknown = await measuredWorkflowStep(meter, async () =>
                  step.do(
                    treeId,
                    { retries: { limit: 5, delay: 0 } },
                    async () => ({ digest, record: await work() }) as never,
                  ),
                );
                if (
                  !recorded ||
                  typeof recorded !== "object" ||
                  Array.isArray(recorded) ||
                  Object.keys(recorded).sort().join(",") !== "digest,record" ||
                  typeof (recorded as { digest?: unknown }).digest !== "string"
                ) {
                  throw new Error("invalid durable cache evidence");
                }
                return recorded as {
                  readonly digest: string;
                  readonly record: Awaited<ReturnType<typeof work>>;
                };
              },
            },
            {
              key: declaration.key,
              path,
              ...(declaration.restoreKeys ? { restoreKeys: declaration.restoreKeys } : {}),
              ...(declaration.budget ? { budget: declaration.budget } : {}),
            },
          ),
        });
      }
      const hits = results.filter(
        (
          entry,
        ): entry is typeof entry & {
          result: Extract<(typeof entry)["result"], { state: "hit" }>;
        } => entry.result.state === "hit",
      );
      if (hits.length > 0 && hits.length !== results.length) {
        await binding.discardCaches({
          runId,
          paths: hits.map((entry) => normalizedCacheTarget(entry.path)),
          secrets,
        });
      }
      const miss = results.find((entry) => entry.result.state !== "hit")?.result;
      if (miss) return miss;
      const first = hits[0]!.result;
      if (hits.some((entry) => entry.result.key !== first.key)) {
        await binding.discardCaches({
          runId,
          paths: hits.map((entry) => normalizedCacheTarget(entry.path)),
          secrets,
        });
        return { state: "miss", reason: "absent" };
      }
      return {
        state: "hit",
        bytes: hits.reduce((total, entry) => total + entry.result.bytes, 0),
        key: first.key,
        match: hits.some((entry) => entry.result.match === "restore") ? "restore" : "exact",
      };
    },
    sleep: (id: string, durationMs: number): Promise<void> =>
      measuredWorkflowStep(meter, async () => await step.sleep(id, durationMs)),
  };
  return {
    ...operations,
    cleanup: async () => {
      if (sandbox.hasPendingCaches()) {
        const recorded = (await measuredWorkflowStep(meter, async () =>
          step.do(
            CACHE_PREPARE_STEP,
            { retries: { limit: 5, delay: 0 } },
            async () => (await sandbox.prepare()) as never,
          ),
        )) as readonly PreparedCache[];
        if (!Array.isArray(recorded)) throw new Error("invalid durable cache preparation");
        preparedCaches = structuredClone(recorded);
      }
      await sandbox.cleanup();
    },
    finish: (finalization) => {
      const ready = preparedCaches.filter(
        (entry): entry is Extract<PreparedCache, { readonly state: "ready" }> =>
          entry.state === "ready",
      );
      return sandbox.finish(finalization, ready, {
        run: async (work) => {
          const identity = await cachePublicationIdentity(finalization, ready);
          const recorded: unknown = await measuredWorkflowStep(meter, async () =>
            step.do(CACHE_PUBLISH_STEP, { retries: { limit: 5, delay: 0 } }, async () => {
              await work();
              return { identity, published: true } as never;
            }),
          );
          if (
            !recorded ||
            typeof recorded !== "object" ||
            Array.isArray(recorded) ||
            Object.keys(recorded).sort().join(",") !== "identity,published" ||
            (recorded as { identity?: unknown }).identity !== identity ||
            (recorded as { published?: unknown }).published !== true
          ) {
            throw new Error("invalid durable cache publication");
          }
        },
      });
    },
  };
};

const makeTerminal = async (
  step: WorkflowStep,
  binding: RuntimeBinding,
  runId: string,
  meter: Meter,
  diagnostic: { value: FailureDiagnostic | null },
): Promise<Terminal> => {
  let winner: TerminalRecord | undefined;
  const state: TerminalState = {
    claim: async (candidate) => {
      winner = (await measuredWorkflowStep(meter, async () =>
        step.do(
          TERMINAL_CLAIM_STEP,
          async () => (await binding.claimTerminal(runId, candidate)) as never,
        ),
      )) as TerminalRecord;
      return winner;
    },
    read: async () => (await binding.readTerminal(runId)) ?? winner,
  };
  return new Terminal(
    await binding.terminal(runId),
    state,
    async (finalization) => {
      await measuredWorkflowStep(meter, async () =>
        step.do(TERMINAL_PUBLISH_STEP, async () => {
          await binding.publishTerminal(
            runId,
            finalization,
            finalization.outcome === "failure" ? diagnostic.value : null,
          );
        }),
      );
    },
    { meter },
  );
};

export const toEntrypoint = (
  def: WorkflowDefinition,
): typeof WorkflowEntrypoint<unknown, unknown> =>
  class extends WorkflowEntrypoint<unknown, unknown> {
    override async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<unknown> {
      const binding = (this.env as DynamicWorkerEnv)[RUNTIME_BINDING];
      if (!binding) throw new Error(`missing runtime binding: ${RUNTIME_BINDING}`);
      const meter = new Meter({
        priceTable: CLOUDFLARE_PRICE_TABLE,
        container: SANDBOX_CAPACITY,
        emit: (report) => console.log({ type: "runway-meter", report }),
      });
      const diagnostic: { value: FailureDiagnostic | null } = { value: null };
      const terminal = await makeTerminal(step, binding, event.instanceId, meter, diagnostic);
      const started = (await measuredWorkflowStep(meter, async () =>
        step.do(
          TERMINAL_START_STEP,
          async () => (await binding.startRun(event.instanceId)) as never,
        ),
      )) as boolean;
      if (!started) {
        await meter.flush().catch(() => {});
        return undefined;
      }
      let secrets: Readonly<Record<string, string>>;
      try {
        const snapshot = await measuredWorkflowStep(meter, async () =>
          step.do(
            SECRET_SNAPSHOT_STEP,
            async () => (await binding.captureSecrets(event.instanceId)) as never,
          ),
        );
        secrets = secretsOf(def.secrets, await binding.restoreSecrets(event.instanceId, snapshot));
      } catch (error) {
        await terminal.publish(await terminal.claim("failure"));
        throw error;
      }
      const runtime = makeStepRuntime(
        step,
        binding,
        event.instanceId,
        secrets,
        await binding.source(),
        terminal,
        meter,
      );
      let result: unknown;
      let failed = false;
      let failure: unknown;
      try {
        result = await def.run(
          makeStep(
            { ...runtime, ...withTools(runtime, def.tools) },
            {
              runId: event.instanceId,
              secrets,
            },
          ),
          event.payload,
        );
      } catch (error) {
        failed = true;
        failure = error;
        diagnostic.value = failureDiagnosticOf(error, secrets);
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
