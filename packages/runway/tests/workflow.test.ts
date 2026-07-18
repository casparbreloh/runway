import type { StandardSchemaV1 } from "@standard-schema/spec";
import { cron, github, webhook, workflow } from "runway";
import type { CronParams, ExecOptions, ExecResult, SecretRef } from "runway";
import { expect, expectTypeOf, test } from "vitest";

import { secretNameOf } from "../src/secrets.ts";
import { makeStep } from "../src/step.ts";

const secretRef = <N extends string>(name: N): SecretRef<N> => {
  let ref: SecretRef<N> | undefined;
  workflow({
    id: "secret-source",
    secrets: [name],
    trigger: (ctx) => {
      ref = ctx.secrets[name];
      return cron("* * * * *");
    },
  }).run(async () => {});
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

test("a workflow run types secrets, events, and flat durable operations", () => {
  workflow({
    id: "flat-run",
    secrets: ["API_KEY"],
    trigger: () => cron("0 9 * * *"),
  }).run(async (run, event) => {
    expectTypeOf<keyof typeof run>().toEqualTypeOf<
      "runId" | "secrets" | "do" | "exec" | "cache" | "sleep"
    >();
    expectTypeOf(run.secrets.API_KEY).toEqualTypeOf<string>();
    expectTypeOf(event).toEqualTypeOf<CronParams>();
    expectTypeOf<Parameters<typeof run.do>>().toMatchTypeOf<[id: string, work: () => unknown]>();
    expectTypeOf<Parameters<typeof run.exec>>().toEqualTypeOf<
      [id: string, command: string | ExecOptions]
    >();
    expectTypeOf<Parameters<typeof run.sleep>>().toEqualTypeOf<[id: string, durationMs: number]>();
  });
});

test("a cache miss permits the next authored operation", async () => {
  const calls: string[] = [];
  const operations = {
    do: async (_id, work) => await work(),
    exec: async (id) => {
      calls.push(id);
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
    },
    cache: async (id) => {
      calls.push(id);
      return { state: "miss", reason: "absent" };
    },
    sleep: async () => {},
  } satisfies Parameters<typeof makeStep>[0];
  const run = makeStep(operations, { runId: "run-1", secrets: {} });

  await expect(run.cache("build", { key: "v1", paths: [".build"] })).resolves.toEqual({
    state: "miss",
    reason: "absent",
  });
  expect(() =>
    run.cache("budgeted", {
      key: "v1",
      paths: [".one", ".two"],
      budget: { maxBytes: 100 },
    }),
  ).toThrow("cache budgets require a single path");
  await run.exec("compile", "compile");
  expect(calls).toEqual(["build", "compile"]);
});

test("workflow authoring exposes no legacy handler or nested context", () => {
  const author = workflow({ id: "clean-author", trigger: () => cron("0 9 * * *") });
  expectTypeOf(author).not.toHaveProperty("handler");
  expect(author).not.toHaveProperty("handler");

  const definition = author.run(async (run) => {
    expectTypeOf(run).not.toHaveProperty("env");
    expectTypeOf(run).not.toHaveProperty("step");
  });
  expect(definition).not.toHaveProperty("handler");
});

test("the authoring API types secrets, runs, raw webhooks, and cron events", () => {
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
  }).run(async (run, event) => {
    type SleepParams = Parameters<typeof run.sleep>;
    expectTypeOf<keyof typeof run>().toEqualTypeOf<
      "runId" | "secrets" | "do" | "exec" | "cache" | "sleep"
    >();
    expectTypeOf<SleepParams>().toEqualTypeOf<[id: string, durationMs: number]>();
    expectTypeOf(run.secrets.API_KEY).toEqualTypeOf<string>();
    expectTypeOf(event).toBeUnknown();
  });

  workflow({ id: "typed-cron", trigger: () => cron("0 9 * * *") }).run(async (_run, event) => {
    expectTypeOf(event).toEqualTypeOf<CronParams>();
  });
});

test("a GitHub push trigger is declarative and types its normalized event", () => {
  const definition = workflow({
    id: "github-push",
    trigger: () => github({ checkName: "Check", events: [{ type: "push", branches: ["main"] }] }),
  }).run(async (_run, event) => {
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
  }).run(async (_run, event) => {
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
  }).run(async (_run, event) => {
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

test("run.exec delegates string and options commands with their durable ids", async () => {
  const calls: Array<[string, string | ExecOptions]> = [];
  const result: ExecResult = {
    exitCode: 0,
    stdout: "v26.0.0\n",
    stderr: "",
    durationMs: 12,
  };
  const operations = {
    do: async (_id, work) => await work(),
    exec: async (id, command) => {
      calls.push([id, command]);
      return result;
    },
    cache: async () => ({ state: "miss", reason: "absent" }),
    sleep: async () => {},
  } satisfies Parameters<typeof makeStep>[0];
  const run = makeStep(operations, { runId: "run-1", secrets: {} });
  const options = {
    command: "pnpm test",
    cwd: "packages/app",
    env: { NODE_ENV: "test" },
    timeoutMs: 1_200_000,
  } as const;

  await expect(run.exec("runtime", "node --version")).resolves.toBe(result);
  await expect(run.exec("test", options)).resolves.toBe(result);
  expect(calls).toEqual([
    ["runtime", "node --version"],
    ["test", options],
  ]);
});

test("workflow runs cannot use Runway's internal id namespace", () => {
  const operations = {
    do: async (_id, work) => await work(),
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
    cache: async () => ({ state: "miss", reason: "absent" }),
    sleep: async () => {},
  } satisfies Parameters<typeof makeStep>[0];
  const run = makeStep(operations, { runId: "run-1", secrets: {} });

  expect(() => run.do("runway:secret-snapshot", () => undefined)).toThrow(
    'operation id "runway:secret-snapshot" is reserved by Runway',
  );
  expect(() => run.exec("runway:command", "true")).toThrow(
    'operation id "runway:command" is reserved by Runway',
  );
  expect(() => run.cache("runway:cache", { key: "v1", paths: ["/cache/tree"] })).toThrow(
    'operation id "runway:cache" is reserved by Runway',
  );
  expect(() => run.sleep("runway:wait", 1)).toThrow(
    'operation id "runway:wait" is reserved by Runway',
  );
});

test("operation ids contain between 1 and 128 UTF-8 bytes", async () => {
  const observed: string[] = [];
  const operations = {
    do: async (id, work) => {
      observed.push(id);
      return await work();
    },
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
    cache: async () => ({ state: "miss", reason: "absent" }),
    sleep: async () => {},
  } satisfies Parameters<typeof makeStep>[0];
  const run = makeStep(operations, { runId: "run-1", secrets: {} });
  const multibyteBoundary = "é".repeat(64);

  await expect(run.do(multibyteBoundary, () => "ok")).resolves.toBe("ok");
  expect(observed).toEqual([multibyteBoundary]);
  expect(() => run.do("", () => undefined)).toThrow(
    "operation id must contain between 1 and 128 UTF-8 bytes",
  );
  expect(() => run.do("a".repeat(129), () => undefined)).toThrow(
    "operation id must contain between 1 and 128 UTF-8 bytes",
  );
  expect(() => run.do("é".repeat(65), () => undefined)).toThrow(
    "operation id must contain between 1 and 128 UTF-8 bytes",
  );
});

test("schema validation and filtering narrow the run event", () => {
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
  }).run(async (_run, event) => {
    expectTypeOf(event).toEqualTypeOf<{ action: "create" }>();
  });
});
