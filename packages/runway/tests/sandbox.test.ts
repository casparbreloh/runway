import { expect, test } from "vitest";

import { makeRun } from "../src/run.ts";
import { Sandbox } from "../src/sandbox.ts";
import { source } from "../src/source.ts";

const durable = (id: string, events?: string[]) => ({
  id,
  run: async <T>(
    work: (identity: { count: number; attempt: number }) => Promise<T>,
  ): Promise<T> => {
    events?.push(`durable:${id}`);
    return await work({ count: 1, attempt: 1 });
  },
});

test("invalid or non-immutable source revisions fail before placement mutation", async () => {
  for (const revision of ["main", "a".repeat(39), "g".repeat(40), "A".repeat(40)]) {
    let placementMutated = false;

    expect(() =>
      source(
        {
          repositoryId: "repository-1",
          remote: "https://github.com/acme/example",
          revision,
        },
        {
          prepare: async () => {
            placementMutated = true;
            return { revision, state: "prepared", bytes: 0 };
          },
        },
      ),
    ).toThrow("source revision must be an exact 40-character lowercase Git object id");
    expect(placementMutated).toBe(false);
  }
});

test("one exact public source prepares before one command executes", async () => {
  const revision = "1".repeat(40);
  const events: string[] = [];
  const exactSource = source(
    {
      repositoryId: "repository-1",
      remote: "https://github.com/acme/example",
      revision,
    },
    {
      prepare: async () => {
        events.push(`prepare:${revision}`);
        return { revision, state: "prepared", bytes: 123 };
      },
    },
  );
  const sandbox = new Sandbox({
    runId: "run-1",
    secrets: {},
    source: exactSource,
    placement: {
      exec: async ({ source: prepared, command }) => {
        events.push(`exec:${prepared.revision}:${command.command}`);
        return { exitCode: 0, stdout: `${prepared.revision}\n`, stderr: "", durationMs: 4 };
      },
      destroy: async () => {},
    },
  });

  await expect(
    sandbox.exec(durable("checkout", events), {
      command: "git rev-parse HEAD",
      cwd: "/workspace",
      env: { CI: "true" },
      timeoutMs: 1000,
    }),
  ).resolves.toEqual({ exitCode: 0, stdout: `${revision}\n`, stderr: "", durationMs: 4 });
  expect(events).toEqual([
    "durable:checkout",
    `prepare:${revision}`,
    `exec:${revision}:git rev-parse HEAD`,
  ]);
});

test("source preparation validates state and transferred bytes after transport", async () => {
  const revision = "1".repeat(40);
  for (const result of [
    { revision, state: "unknown", bytes: 1 },
    { revision, state: "prepared", bytes: -1 },
    { revision, state: "prepared", bytes: 1.5 },
    { revision, state: "prepared", bytes: 1, credential: "must-not-cross" },
  ]) {
    const exactSource = source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      { prepare: async () => result as never },
    );

    await expect(exactSource.prepare()).rejects.toThrow("source preparation result is invalid");
  }
});

test("an authenticated source confines its purpose-scoped credential to checkout", async () => {
  const revision = "2".repeat(40);
  const token = "github-checkout-token";
  const issuerRequests: unknown[] = [];
  const checkoutEnvironments: Array<Record<string, string>> = [];
  const preparedSources: unknown[] = [];
  const metrics: unknown[] = [];
  const issueCredential = async (request: { purpose: "checkout"; repositoryId: string }) => {
    issuerRequests.push(request);
    return token;
  };
  const exactSource = source(
    {
      repositoryId: "github:17",
      remote: "https://github.com/acme/private",
      revision,
    },
    {
      prepare: async (preparedSource) => {
        preparedSources.push(preparedSource);
        let credential: string | undefined = await issueCredential({
          purpose: "checkout",
          repositoryId: preparedSource.repositoryId,
        });
        const environment = { RUNWAY_GITHUB_TOKEN: credential };
        checkoutEnvironments.push(environment);
        metrics.push({ type: "source", state: "prepared", bytes: 91 });
        credential = undefined;
        return { revision, state: "prepared", bytes: 91 };
      },
    },
  );

  const result = await exactSource.prepare();
  expect(issuerRequests).toEqual([{ purpose: "checkout", repositoryId: "github:17" }]);
  expect(preparedSources).toEqual([
    {
      repositoryId: "github:17",
      remote: "https://github.com/acme/private",
      revision,
    },
  ]);
  expect(checkoutEnvironments).toEqual([{ RUNWAY_GITHUB_TOKEN: token }]);
  expect(
    JSON.stringify({ source: exactSource, result, metrics, error: new Error("checkout failed") }),
  ).not.toContain(token);
  expect(exactSource.remote).toBe("https://github.com/acme/private");
});

test("do and sleep allocate no placement and cleanup destroys a lazy command placement", async () => {
  const revision = "3".repeat(40);
  let prepares = 0;
  let destroys = 0;
  const exactSource = source(
    {
      repositoryId: "repository-1",
      remote: "https://github.com/acme/example",
      revision,
    },
    {
      prepare: async () => {
        prepares += 1;
        return { revision, state: "prepared", bytes: 10 };
      },
    },
  );
  const sandbox = new Sandbox({
    runId: "run-1",
    secrets: {},
    source: exactSource,
    placement: {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
      destroy: async () => {
        destroys += 1;
      },
    },
  });
  const run = makeRun(
    {
      do: async (_id, work) => await work(),
      exec: async (id, command) =>
        await sandbox.exec(
          durable(id),
          typeof command === "string"
            ? { command, cwd: "/workspace", env: { CI: "true" }, timeoutMs: 1000 }
            : {
                cwd: "/workspace",
                env: { CI: "true" },
                timeoutMs: 1000,
                ...command,
              },
        ),
      sleep: async () => {},
    },
    { runId: "run-1", secrets: {} },
  );

  await run.do("local", () => "done");
  await run.sleep("pause", 1);
  await sandbox.cleanup();
  expect({ prepares, destroys }).toEqual({ prepares: 0, destroys: 0 });

  await run.exec("command", "true");
  await sandbox.cleanup();
  await sandbox.cleanup();
  expect({ prepares, destroys }).toEqual({ prepares: 1, destroys: 1 });
});

test("commands share one prepared source and preserve workspace mutation", async () => {
  const revision = "4".repeat(40);
  let preparations = 0;
  let workspace = "";
  const sandbox = new Sandbox({
    runId: "run-shared-workspace",
    secrets: {},
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      {
        prepare: async () => {
          preparations += 1;
          return { revision, state: "prepared", bytes: 10 };
        },
      },
    ),
    placement: {
      exec: async ({ command }) => {
        if (command.command === "write") workspace = "preserved\n";
        return {
          exitCode: 0,
          stdout: command.command === "read" ? workspace : "",
          stderr: "",
          durationMs: 1,
        };
      },
      destroy: async () => {},
    },
  });

  await expect(sandbox.exec(durable("write"), "write")).resolves.toMatchObject({ exitCode: 0 });
  await expect(sandbox.exec(durable("read"), "read")).resolves.toMatchObject({
    stdout: "preserved\n",
  });
  expect(preparations).toBe(1);
});

test("a failed source preparation remains retryable", async () => {
  const revision = "5".repeat(40);
  let preparations = 0;
  const sandbox = new Sandbox({
    runId: "run-retry-preparation",
    secrets: {},
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      {
        prepare: async () => {
          preparations += 1;
          if (preparations === 1) throw new Error("transient preparation failure");
          return { revision, state: "prepared", bytes: 10 };
        },
      },
    ),
    placement: {
      exec: async () => ({ exitCode: 0, stdout: "ready\n", stderr: "", durationMs: 1 }),
      destroy: async () => {},
    },
  });

  await expect(sandbox.exec(durable("first"), "true")).rejects.toThrow(
    "transient preparation failure",
  );
  await expect(sandbox.exec(durable("retry"), "true")).resolves.toMatchObject({
    stdout: "ready\n",
  });
  expect(preparations).toBe(2);
});

test("a nonzero result crosses the durable boundary once before becoming an ExecError", async () => {
  const revision = "6".repeat(40);
  let executions = 0;
  let durableResult: unknown;
  const sandbox = new Sandbox({
    runId: "run-nonzero",
    secrets: {},
    source: source(
      {
        repositoryId: "repository-1",
        remote: "https://github.com/acme/example",
        revision,
      },
      { prepare: async () => ({ revision, state: "prepared", bytes: 0 }) },
    ),
    placement: {
      exec: async () => {
        executions += 1;
        return { exitCode: 7, stdout: "", stderr: "failed\n", durationMs: 1 };
      },
      destroy: async () => {},
    },
  });

  await expect(
    sandbox.exec(
      {
        id: "fail",
        run: async (work) => {
          durableResult = await work({ count: 1, attempt: 1 });
          return durableResult as never;
        },
      },
      "exit 7",
    ),
  ).rejects.toMatchObject({ name: "ExecError", result: { exitCode: 7 } });
  expect({ durableResult, executions }).toEqual({
    durableResult: { exitCode: 7, stdout: "", stderr: "failed\n", durationMs: 1 },
    executions: 1,
  });
});
