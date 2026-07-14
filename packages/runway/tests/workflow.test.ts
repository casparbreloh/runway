import type { StandardSchemaV1 } from "@standard-schema/spec";
import { cron, makeCtx, secretNameOf, webhook, workflow } from "runway";
import type { CronParams, ExecOptions, ExecResult, Primitives, SecretRef } from "runway";
import { expect, expectTypeOf, test } from "vitest";

const secretRef = <N extends string>(name: N): SecretRef<N> => {
  let ref: SecretRef<N> | undefined;
  workflow({
    id: "secret-source",
    secrets: [name],
    trigger: (ctx) => {
      ref = ctx.secrets[name];
      return cron("* * * * *");
    },
  }).handler(async () => {});
  return ref!;
};

test("invalid workflow definitions fail before registration", () => {
  expect(() => workflow({ id: "BadName", trigger: () => cron("* * * * *") })).toThrow(
    'invalid workflow id "BadName": must be kebab-case',
  );
  expect(() =>
    workflow({ id: "hello", secrets: ["bad-name"], trigger: () => cron("* * * * *") }),
  ).toThrow('invalid workflow secret "bad-name": must be a valid binding name');
  expect(() =>
    workflow({
      id: "hello",
      secrets: ["API_KEY", "API_KEY"],
      trigger: () => cron("* * * * *"),
    }),
  ).toThrow('duplicate workflow secret "API_KEY"');
});

test("a webhook signing secret must belong to its workflow", () => {
  const foreign = secretRef("FOREIGN_SECRET");

  expect(() =>
    workflow({
      id: "review",
      trigger: () => webhook({ path: "/review", secret: foreign, signatureHeader: "x-signature" }),
    }),
  ).toThrow('workflow webhook secret "FOREIGN_SECRET" must be declared in secrets');
});

test("the authoring API types secrets, context, raw webhooks, and cron events", () => {
  workflow({
    id: "typed-webhook",
    secrets: ["HOOK_SECRET", "API_KEY"],
    trigger: (ctx) => {
      expect(secretNameOf(ctx.secrets.HOOK_SECRET)).toBe("HOOK_SECRET");
      expectTypeOf<keyof typeof ctx.secrets>().toEqualTypeOf<"HOOK_SECRET" | "API_KEY">();
      expectTypeOf(ctx.secrets.API_KEY).toEqualTypeOf<SecretRef<"API_KEY">>();
      return webhook({
        path: "/typed",
        secret: ctx.secrets.HOOK_SECRET,
        signatureHeader: "x-signature",
      });
    },
  }).handler(async (ctx, event) => {
    type SleepParams = Parameters<(typeof ctx.step)["sleep"]>;
    expectTypeOf<keyof typeof ctx>().toEqualTypeOf<"runId" | "secrets" | "env" | "step">();
    expectTypeOf<keyof typeof ctx.step>().toEqualTypeOf<"do" | "exec" | "sleep">();
    expectTypeOf<SleepParams>().toEqualTypeOf<[id: string, durationMs: number]>();
    expectTypeOf(ctx.secrets.API_KEY).toEqualTypeOf<string>();
    expectTypeOf(event).toBeUnknown();
  });

  workflow({ id: "typed-cron", trigger: () => cron("0 9 * * *") }).handler(async (_ctx, event) => {
    expectTypeOf(event).toEqualTypeOf<CronParams>();
  });
});

test("step.exec delegates string and options commands with their durable ids", async () => {
  const calls: Array<[string, string | ExecOptions]> = [];
  const result: ExecResult = {
    exitCode: 0,
    stdout: "v26.0.0\n",
    stderr: "",
    durationMs: 12,
  };
  const primitives: Primitives = {
    step: {
      do: async (_id, fn) => await fn(),
      exec: async (id, command) => {
        calls.push([id, command]);
        return result;
      },
      sleep: async () => {},
    },
  };
  const ctx = makeCtx(primitives, { runId: "run-1", secrets: {}, env: {} });
  const options = {
    command: "pnpm test",
    cwd: "packages/app",
    env: { NODE_ENV: "test" },
    timeoutMs: 1_200_000,
  } as const;

  await expect(ctx.step.exec("runtime", "node --version")).resolves.toBe(result);
  await expect(ctx.step.exec("test", options)).resolves.toBe(result);
  expect(calls).toEqual([
    ["runtime", "node --version"],
    ["test", options],
  ]);
});

test("schema validation and filtering narrow the handler event", () => {
  const schema: StandardSchemaV1<unknown, { action: string }> = {
    "~standard": {
      version: 1,
      vendor: "runway-test",
      validate: (value) => ({ value: value as { action: string } }),
    },
  };

  workflow({
    id: "schemaed",
    secrets: ["HOOK_SECRET"],
    trigger: (ctx) =>
      webhook({
        path: "/schemaed",
        secret: ctx.secrets.HOOK_SECRET,
        signatureHeader: "x-signature",
        schema,
      }).filter((event): event is { action: "create" } => event.action === "create"),
  }).handler(async (_ctx, event) => {
    expectTypeOf(event).toEqualTypeOf<{ action: "create" }>();
  });
});
