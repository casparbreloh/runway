import { expect, test } from "vitest";

import { cron, webhook } from "../src/trigger.ts";
import { createWorkflow } from "../src/workflow.ts";

test("rejects secret names that are not valid bindings", () => {
  expect(() => createWorkflow({ id: "hello", secrets: ["linear-api-key"] })).toThrow(
    'invalid workflow secret "linear-api-key": must be a valid binding name',
  );
});

test("rejects duplicate secret names", () => {
  expect(() =>
    createWorkflow({ id: "hello", secrets: ["LINEAR_API_KEY", "LINEAR_API_KEY"] }),
  ).toThrow('duplicate workflow secret "LINEAR_API_KEY"');
});

test("rejects webhook secrets that are not declared on the workflow", () => {
  expect(() =>
    createWorkflow({ id: "hello" })
      // @ts-expect-error the webhook secret must be a declared workflow secret
      .trigger(webhook({ path: "/hook", secret: "HOOK_SECRET", header: "x-signature" })),
  ).toThrow('workflow webhook secret "HOOK_SECRET" must be declared in secrets');
});

test("defaults secrets to an empty list and types cron params", () => {
  const def = createWorkflow({ id: "daily" })
    .trigger(cron("0 9 * * *"))
    .handler(async (ctx) => {
      const at: number = ctx.params.scheduledTime;
      void at;
    });
  expect(def.secrets).toEqual([]);
  expect(def.trigger).toEqual({ type: "cron", cron: "0 9 * * *" });
});

test("types ctx.params from the trigger handle and skips on undefined", () => {
  interface Event {
    readonly action: string;
    readonly data: { readonly title: string };
  }
  const def = createWorkflow({ id: "typed", secrets: ["TYPED_WEBHOOK_SECRET"] })
    .trigger(
      webhook(
        { path: "/typed", secret: "TYPED_WEBHOOK_SECRET", header: "x-signature" },
        (event: Event) => (event.action === "create" ? event.data : undefined),
      ),
    )
    .handler(async (ctx) => {
      const title: string = ctx.params.title;
      const hook: string = ctx.secrets.TYPED_WEBHOOK_SECRET;
      void title;
      void hook;
      // @ts-expect-error params is the handle's return type
      void ctx.params.missing;
    });
  const handle = def.trigger.type === "webhook" ? def.trigger.handle : undefined;
  expect(handle?.({ action: "remove", data: { title: "t" } })).toBeUndefined();
  expect(handle?.({ action: "create", data: { title: "t" } })).toEqual({ title: "t" });
});
