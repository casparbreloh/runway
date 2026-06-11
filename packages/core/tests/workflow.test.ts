import type { StandardSchemaV1 } from "@standard-schema/spec";
import { expect, expectTypeOf, test } from "vitest";

import { makeCtx } from "../src/ctx.ts";
import { secretNameOf } from "../src/secrets.ts";
import type { SecretRef } from "../src/secrets.ts";
import { cron, validateTrigger, webhook } from "../src/trigger.ts";
import type { CronParams } from "../src/types.ts";
import { workflow } from "../src/workflow.ts";

const refOf = <N extends string>(name: N): SecretRef<N> => {
  let ref: SecretRef<N> | undefined;
  workflow({
    id: "donor",
    secrets: [name],
    trigger: (tctx) => {
      ref = tctx.secrets[name];
      return cron("* * * * *");
    },
  }).handler(async () => {});
  return ref!;
};

test("rejects secret names that are not valid bindings", () => {
  expect(() =>
    workflow({ id: "hello", secrets: ["linear-api-key"], trigger: () => cron("* * * * *") }),
  ).toThrow('invalid workflow secret "linear-api-key": must be a valid binding name');
});

test("rejects duplicate secret names", () => {
  expect(() =>
    workflow({
      id: "hello",
      secrets: ["LINEAR_API_KEY", "LINEAR_API_KEY"],
      trigger: () => cron("* * * * *"),
    }),
  ).toThrow('duplicate workflow secret "LINEAR_API_KEY"');
});

test("invokes the trigger callback once and stores its result by reference", () => {
  const trigger = cron("0 9 * * *");
  let calls = 0;
  const def = workflow({
    id: "daily",
    trigger: () => {
      calls += 1;
      return trigger;
    },
  }).handler(async () => {});
  expect(calls).toBe(1);
  expect(def.trigger).toBe(trigger);
  expect(def.__kind).toBe("workflow");
  expect(def.id).toBe("daily");
  expect(def.secrets).toEqual([]);
});

test("the trigger context exposes exactly the declared secrets as name-carrying refs", () => {
  const seen: Array<{ keys: ReadonlyArray<string>; alpha: string; beta: string }> = [];
  workflow({
    id: "ctx-shape",
    secrets: ["ALPHA_KEY", "BETA_KEY"],
    trigger: (tctx) => {
      seen.push({
        keys: Object.keys(tctx.secrets),
        alpha: secretNameOf(tctx.secrets.ALPHA_KEY),
        beta: secretNameOf(tctx.secrets.BETA_KEY),
      });
      return cron("* * * * *");
    },
  }).handler(async () => {});
  expect(seen).toEqual([{ keys: ["ALPHA_KEY", "BETA_KEY"], alpha: "ALPHA_KEY", beta: "BETA_KEY" }]);
});

test("throws when the trigger captures a secret ref not declared on this workflow", () => {
  const foreign = refOf("FOREIGN_SECRET");
  for (const opts of [{ id: "thief", secrets: ["OWN_SECRET"] }, { id: "bare" }] as const) {
    expect(() =>
      workflow({
        ...opts,
        trigger: () =>
          webhook({ path: `/${opts.id}`, secret: foreign, signatureHeader: "x-signature" }),
      }),
    ).toThrow('workflow webhook secret "FOREIGN_SECRET" must be declared in secrets');
  }
});

test("rejects invalid workflow and trigger shapes", () => {
  const ref = refOf("HOOK_SECRET");
  expect(() => workflow({ id: "BadName", trigger: () => cron("* * * * *") })).toThrow(
    'invalid workflow id "BadName": must be kebab-case',
  );
  expect(() => validateTrigger(cron(" "))).toThrow(
    "invalid workflow cron trigger: expression is required",
  );
  for (const [trigger, message] of [
    [
      webhook({ path: "linear", secret: ref, signatureHeader: "x-signature" }),
      'invalid workflow trigger path "linear": must start with "/"',
    ],
    [
      webhook({ path: "/linear//events", secret: ref, signatureHeader: "x-signature" }),
      'invalid workflow trigger path "/linear//events": contains "//"',
    ],
    [
      webhook({ path: "/linear", secret: ref, signatureHeader: "" }),
      "invalid workflow webhook signatureHeader: a signature header is required",
    ],
    [
      webhook({
        path: "/linear",
        secret: ref,
        signatureHeader: "x-signature",
        timestamp: { field: "ts", toleranceMs: 0 },
      }),
      "invalid workflow webhook timestamp tolerance: must be positive",
    ],
  ] as const) {
    expect(() => validateTrigger(trigger)).toThrow(message);
  }
});

test("makeCtx forwards stable step ids and positional sleep ids", async () => {
  const calls: unknown[] = [];
  const ctx = makeCtx(
    {
      step: async (id, fn) => {
        calls.push(["step", id]);
        return fn();
      },
      sleep: async (id, ms) => {
        calls.push(["sleep", id, ms]);
      },
    },
    { runId: "run-1", secrets: { API_KEY: "key" }, env: { binding: true } },
  );

  const result = await ctx.step("fetch-linear", (step) => ({ id: step.id, runId: ctx.runId }));
  await ctx.sleep(10);
  await ctx.sleep(25);

  expect(result).toEqual({ id: "fetch-linear", runId: "run-1" });
  expect(ctx.secrets.API_KEY).toBe("key");
  expect(ctx.env).toEqual({ binding: true });
  expect(calls).toEqual([
    ["step", "fetch-linear"],
    ["sleep", "sleep-0", 10],
    ["sleep", "sleep-1", 25],
  ]);
});

test("types the trigger context, handler secrets, and the raw webhook event", () => {
  const def = workflow({
    id: "typed",
    secrets: ["LINEAR_WEBHOOK_SECRET", "LINEAR_API_KEY"],
    trigger: (tctx) => {
      expectTypeOf<keyof typeof tctx.secrets>().toEqualTypeOf<
        "LINEAR_WEBHOOK_SECRET" | "LINEAR_API_KEY"
      >();
      expectTypeOf(tctx.secrets.LINEAR_API_KEY).toEqualTypeOf<SecretRef<"LINEAR_API_KEY">>();
      const wantsString = (value: string): string => value;
      // @ts-expect-error a secret ref is not usable where a string is expected
      void wantsString(tctx.secrets.LINEAR_API_KEY);
      // @ts-expect-error undeclared secret names are not offered on the trigger context
      void tctx.secrets.TYPO;
      return webhook({
        path: "/typed",
        secret: tctx.secrets.LINEAR_WEBHOOK_SECRET,
        signatureHeader: "x-signature",
      });
    },
  }).handler(async (ctx, event) => {
    expectTypeOf(ctx.secrets.LINEAR_API_KEY).toEqualTypeOf<string>();
    expectTypeOf(event).toBeUnknown();
  });
  expect(def.trigger.type).toBe("webhook");
});

test("types the cron event as CronParams", () => {
  const def = workflow({ id: "tick", trigger: () => cron("* * * * *") }).handler(
    async (_ctx, event) => {
      expectTypeOf(event).toEqualTypeOf<CronParams>();
    },
  );
  expect(def.trigger).toEqual({ type: "cron", expression: "* * * * *" });
});

test("types the schema rung event as the validate output and rejects misuse", () => {
  const ref = refOf("HOOK_SECRET");
  const schema: StandardSchemaV1<unknown, { ok: boolean }> = {
    "~standard": {
      version: 1,
      vendor: "runway-test",
      validate: (value) => ({ value: value as { ok: boolean } }),
    },
  };
  const def = workflow({
    id: "schemaed",
    secrets: ["HOOK_SECRET"],
    trigger: (tctx) =>
      webhook({
        path: "/schemaed",
        secret: tctx.secrets.HOOK_SECRET,
        signatureHeader: "x-signature",
        schema,
      }),
  }).handler(async (_ctx, event) => {
    expectTypeOf(event).toEqualTypeOf<{ ok: boolean }>();
  });
  expect(def.trigger.type).toBe("webhook");

  // @ts-expect-error a raw string is not a SecretRef
  void webhook({ path: "/t", secret: "HOOK_SECRET", signatureHeader: "x-signature" });
  const combined = { path: "/t", secret: ref, signatureHeader: "x-signature", schema };
  // @ts-expect-error schema and an explicit event type cannot combine
  void webhook<{ ok: boolean }>(combined);
  const raw = webhook<{ action: string }>({
    path: "/t",
    secret: ref,
    signatureHeader: "x-signature",
  });
  // @ts-expect-error filter requires a type-guard predicate
  void raw.filter((event) => event.action === "create");
});
