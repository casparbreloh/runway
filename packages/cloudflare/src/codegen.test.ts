import assert from "node:assert/strict";
import { test } from "node:test";

import type { Registry } from "@runway/core";

import { generateWorker, generateWranglerConfig } from "./codegen.ts";

const registry: Registry = [
  {
    path: "src/hello.ts",
    def: {
      __kind: "workflow",
      id: "hello",
      trigger: {
        type: "webhook",
        path: "/hello",
        auth: {
          type: "raw-hmac-sha256",
          header: "linear-signature",
          secret: "LINEAR_WEBHOOK_SECRET",
        },
      },
      handler: async () => {},
    },
  },
  {
    path: "src/daily.ts",
    def: {
      __kind: "workflow",
      id: "daily",
      trigger: { type: "cron", cron: "0 9 * * *" },
      handler: async () => {},
    },
  },
];

void test("generates Worker routes from explicit triggers", () => {
  const worker = generateWorker(registry, { cwd: "/app", outDir: "/app/.runway" });

  assert.match(worker, /path: "\/hello"/);
  assert.match(worker, /secret":"LINEAR_WEBHOOK_SECRET"/);
  assert.match(worker, /cron: "0 9 \* \* \*"/);
});

void test("generates Wrangler worker cron triggers", () => {
  const config = JSON.parse(
    generateWranglerConfig(registry, { name: "runway", main: "worker.gen.ts" }),
  ) as {
    workflows: ReadonlyArray<{ name: string; binding: string; class_name: string }>;
    triggers?: { crons: ReadonlyArray<string> };
  };

  assert.deepEqual(config.triggers, { crons: ["0 9 * * *"] });
  assert.deepEqual(config.workflows, [
    { name: "hello", binding: "HELLO", class_name: "Hello" },
    { name: "daily", binding: "DAILY", class_name: "Daily" },
  ]);
  assert.equal("schedules" in config.workflows[1]!, false);
});

void test("rejects duplicate webhook paths", () => {
  assert.throws(
    () =>
      generateWorker(
        [
          registry[0]!,
          {
            ...registry[0]!,
            path: "src/other.ts",
            def: { ...registry[0]!.def, id: "other" },
          },
        ],
        { cwd: "/app", outDir: "/app/.runway" },
      ),
    /duplicate webhook trigger path "\/hello"/,
  );
});

void test("rejects generated class name collisions", () => {
  assert.throws(
    () =>
      generateWorker(
        [
          {
            ...registry[1]!,
            def: { ...registry[1]!.def, id: "daily-alt" },
          },
          {
            ...registry[1]!,
            path: "src/daily-alt.ts",
            def: { ...registry[1]!.def, id: "daily_alt" },
          },
        ],
        { cwd: "/app", outDir: "/app/.runway" },
      ),
    /generated class name DailyAlt already used by src\/daily.ts/,
  );
});
