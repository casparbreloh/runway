import type { Registry } from "@runway/core";
import { expect, test } from "vitest";

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

test("generates Worker routes from explicit triggers", () => {
  const worker = generateWorker(registry, { cwd: "/app", outDir: "/app/.runway" });

  expect(worker).toMatch(/path: "\/hello"/);
  expect(worker).toMatch(/secret":"LINEAR_WEBHOOK_SECRET"/);
  expect(worker).toMatch(/cron: "0 9 \* \* \*"/);
});

test("generates Wrangler worker cron triggers", () => {
  const config = JSON.parse(
    generateWranglerConfig(registry, { name: "runway", main: "worker.gen.ts" }),
  ) as {
    workflows: ReadonlyArray<{ name: string; binding: string; class_name: string }>;
    triggers?: { crons: ReadonlyArray<string> };
  };

  expect(config.triggers).toEqual({ crons: ["0 9 * * *"] });
  expect(config.workflows).toEqual([
    { name: "hello", binding: "HELLO", class_name: "Hello" },
    { name: "daily", binding: "DAILY", class_name: "Daily" },
  ]);
  expect("schedules" in config.workflows[1]!).toBe(false);
});

test("rejects duplicate webhook paths", () => {
  expect(() =>
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
  ).toThrow(/duplicate webhook trigger path "\/hello"/);
});

test("rejects generated class name collisions", () => {
  expect(() =>
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
  ).toThrow(/generated class name DailyAlt already used by src\/daily.ts/);
});
