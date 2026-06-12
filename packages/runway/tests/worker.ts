import { makeCtx, secretNameOf, secretsOf } from "runway";
import type { Primitives, WorkflowDefinition } from "runway";

import { bindingOf } from "../src/naming.ts";
import { createRouter, hmacSha256Hex } from "../src/router.ts";
import { validateRegistry } from "../src/validate.ts";

export interface TestRun {
  readonly id: string;
  readonly workflowId: string;
  readonly params: unknown;
}

export interface TestWorker {
  readonly runs: ReadonlyArray<TestRun>;
  readonly executions: ReadonlyArray<Promise<void>>;
  fetch(req: Request): Promise<Response>;
  webhook(workflowId: string, params?: unknown, opts?: TestWebhookOptions): Promise<Response>;
  scheduled(cron: string, scheduledTime?: number): Promise<void>;
}

export interface TestWorkerOptions {
  readonly secrets?: Record<string, string>;
}

export interface TestWebhookOptions {
  readonly headers?: HeadersInit;
  readonly timestamp?: number;
}

const primitives: Primitives = {
  step: (_id, fn) => fn(),
  sandbox: () => {
    throw new Error("test sandbox is not configured");
  },
  sleep: () => Promise.resolve(),
};

export const createTestWorker = (
  workflows: ReadonlyArray<WorkflowDefinition>,
  opts: TestWorkerOptions = {},
): TestWorker => {
  const runs: TestRun[] = [];
  const executions: Promise<void>[] = [];
  validateRegistry(workflows.map((def) => ({ path: def.id, exportName: "default", def })));
  const entries = workflows.map((def) => ({
    id: def.id,
    binding: bindingOf(def.id),
    trigger: def.trigger,
  }));
  const router = createRouter(entries);
  const env: Record<
    string,
    string | { create(opts: { params: unknown }): Promise<{ id: string }> }
  > = {
    ...opts.secrets,
  };

  for (const def of workflows) {
    env[bindingOf(def.id)] = {
      create: async ({ params }) => {
        const id = `${def.id}-${runs.length + 1}`;
        runs.push({ id, workflowId: def.id, params });
        const execution = Promise.resolve()
          .then(() =>
            def.handler(
              makeCtx(primitives, {
                runId: id,
                secrets: secretsOf(def.secrets, env),
                env,
              }),
              params,
            ),
          )
          .then(() => undefined);
        execution.catch(() => undefined);
        executions.push(execution);
        return { id };
      },
    };
  }

  return {
    runs,
    executions,
    fetch: (req) => router.fetch(req, env),
    async webhook(workflowId, params = {}, webhookOpts = {}) {
      const def = workflows.find((w) => w.id === workflowId);
      if (!def) throw new Error(`unknown workflow: ${workflowId}`);
      if (def.trigger.type !== "webhook") {
        throw new Error(`workflow ${JSON.stringify(workflowId)} does not have a webhook trigger`);
      }
      const secretName = secretNameOf(def.trigger.secret);
      const secret = opts.secrets?.[secretName];
      if (!secret) throw new Error(`missing test secret: ${secretName}`);
      const body = JSON.stringify(params);
      const signature = await hmacSha256Hex(secret, body);
      const headers = new Headers(webhookOpts.headers);
      headers.set("content-type", headers.get("content-type") ?? "application/json");
      headers.set(def.trigger.signatureHeader, `${def.trigger.prefix ?? ""}${signature}`);
      if (def.trigger.timestamp?.source === "header") {
        headers.set(def.trigger.timestamp.field, String(webhookOpts.timestamp ?? Date.now()));
      }
      return router.fetch(
        new Request(`https://runway.test${def.trigger.path}`, {
          method: "POST",
          body,
          headers,
        }),
        env,
      );
    },
    scheduled: (cron, scheduledTime = Date.now()) => router.scheduled({ cron, scheduledTime }, env),
  };
};
