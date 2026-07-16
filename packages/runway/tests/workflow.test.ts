import type { StandardSchemaV1 } from "@standard-schema/spec";
import { cron, github, makeCtx, secretNameOf, webhook, workflow } from "runway";
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
  expect(() =>
    workflow({
      id: "invalid-trigger",
      trigger: () => ({}) as never,
    }),
  ).toThrow("invalid workflow trigger");
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

test("a GitHub push trigger is declarative and types its normalized event", () => {
  const definition = workflow({
    id: "github-push",
    trigger: () => github({ checkName: "Check", events: [{ type: "push", branches: ["main"] }] }),
  }).handler(async (_ctx, event) => {
    expectTypeOf(event).toEqualTypeOf<{
      readonly type: "push";
      readonly repository: {
        readonly id: number;
        readonly name: string;
        readonly fullName: string;
      };
      readonly ref: string;
      readonly sha: string;
    }>();
  });

  expect(JSON.parse(JSON.stringify(definition.trigger))).toEqual({
    type: "github",
    checkName: "Check",
    events: [{ type: "push", branches: ["main"] }],
  });
});

test("a GitHub pull request trigger types only the selected normalized actions", () => {
  workflow({
    id: "github-pr",
    trigger: () =>
      github({
        checkName: "Test",
        events: [{ type: "pull_request", actions: ["opened", "synchronize"] }],
      }),
  }).handler(async (_ctx, event) => {
    expectTypeOf(event).toEqualTypeOf<{
      readonly type: "pull_request";
      readonly action: "opened" | "synchronize";
      readonly repository: {
        readonly id: number;
        readonly name: string;
        readonly fullName: string;
      };
      readonly number: number;
      readonly ref: string;
      readonly sha: string;
    }>();
  });
});

test("a combined GitHub trigger types the selected event union", () => {
  workflow({
    id: "github-combined",
    trigger: () =>
      github({
        checkName: "Check",
        events: [
          { type: "push", branches: ["main", "release"] },
          { type: "pull_request", actions: ["reopened"] },
        ],
      }),
  }).handler(async (_ctx, event) => {
    expectTypeOf(event).toEqualTypeOf<
      | {
          readonly type: "push";
          readonly repository: {
            readonly id: number;
            readonly name: string;
            readonly fullName: string;
          };
          readonly ref: string;
          readonly sha: string;
        }
      | {
          readonly type: "pull_request";
          readonly action: "reopened";
          readonly repository: {
            readonly id: number;
            readonly name: string;
            readonly fullName: string;
          };
          readonly number: number;
          readonly ref: string;
          readonly sha: string;
        }
    >();
  });
});

test("a GitHub trigger requires a non-empty check name", () => {
  expect(() =>
    workflow({
      id: "github-empty-check",
      trigger: () => github({ checkName: "   ", events: [{ type: "push", branches: ["main"] }] }),
    }),
  ).toThrow("invalid workflow GitHub trigger: checkName is required");
});

test("a GitHub trigger requires at least one event filter", () => {
  expect(() =>
    workflow({
      id: "github-empty-events",
      trigger: () => github({ checkName: "Check", events: [] as never }),
    }),
  ).toThrow("invalid workflow GitHub trigger: at least one event is required");
});

test("a GitHub trigger rejects unsupported event types", () => {
  expect(() =>
    workflow({
      id: "github-unsupported-event",
      trigger: () =>
        github({
          checkName: "Check",
          events: [{ type: "issues", actions: ["opened"] }] as never,
        }),
    }),
  ).toThrow('invalid workflow GitHub trigger event type "issues"');
});

test("a GitHub trigger rejects unsupported pull request actions", () => {
  expect(() =>
    workflow({
      id: "github-unsupported-action",
      trigger: () =>
        github({
          checkName: "Check",
          events: [{ type: "pull_request", actions: ["closed"] }] as never,
        }),
    }),
  ).toThrow('invalid workflow GitHub pull_request action "closed"');
});

test("a GitHub pull request filter requires at least one action", () => {
  expect(() =>
    workflow({
      id: "github-empty-actions",
      trigger: () =>
        github({
          checkName: "Check",
          events: [{ type: "pull_request", actions: [] }] as never,
        }),
    }),
  ).toThrow("invalid workflow GitHub pull_request actions: at least one action is required");
});

test("a GitHub push filter requires non-empty branch names", () => {
  expect(() =>
    workflow({
      id: "github-empty-branches",
      trigger: () =>
        github({ checkName: "Check", events: [{ type: "push", branches: [] }] as never }),
    }),
  ).toThrow("invalid workflow GitHub push branches: at least one branch is required");

  expect(() =>
    workflow({
      id: "github-empty-branch",
      trigger: () => github({ checkName: "Check", events: [{ type: "push", branches: [" "] }] }),
    }),
  ).toThrow("invalid workflow GitHub push branch: branch name is required");
});

test("a GitHub trigger rejects duplicate event filters", () => {
  expect(() =>
    workflow({
      id: "github-duplicate-push",
      trigger: () =>
        github({
          checkName: "Check",
          events: [
            { type: "push", branches: ["main"] },
            { type: "push", branches: ["release"] },
          ],
        }),
    }),
  ).toThrow('duplicate workflow GitHub event filter "push"');
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

test("workflow steps cannot use Runway's internal id namespace", () => {
  const primitives: Primitives = {
    step: {
      do: async (_id, fn) => await fn(),
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
      sleep: async () => {},
    },
  };
  const ctx = makeCtx(primitives, { runId: "run-1", secrets: {}, env: {} });

  expect(() => ctx.step.do("runway:secret-snapshot", () => undefined)).toThrow(
    'step id "runway:secret-snapshot" is reserved by Runway',
  );
  expect(() => ctx.step.exec("runway:command", "true")).toThrow(
    'step id "runway:command" is reserved by Runway',
  );
  expect(() => ctx.step.sleep("runway:wait", 1)).toThrow(
    'step id "runway:wait" is reserved by Runway',
  );
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
