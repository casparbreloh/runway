import { expect, test } from "vitest";

import { Meter } from "../src/internal/meter.ts";

test("a bounded structured report distinguishes every run phase without cardinality labels", () => {
  const meter = new Meter();
  meter.record({ type: "sandbox", phase: "ready", durationMs: 11 });
  meter.record({ type: "sandbox", phase: "destroy", durationMs: 3 });
  meter.record({ type: "source", state: "prepared", durationMs: 7, bytes: 100 });
  meter.record({ type: "source", state: "reused", durationMs: 1, bytes: 0 });
  meter.record({ type: "exec", state: "finished", durationMs: 20 });
  meter.record({ type: "exec", state: "reconnected", durationMs: 20 });
  meter.record({ type: "cache", state: "miss", durationMs: 4, bytes: 0 });
  meter.record({ type: "cache", state: "hit", durationMs: 2, bytes: 50 });
  meter.record({ type: "loss", startedCommands: 2 });
  meter.record({ type: "run", outcome: "failure", durationMs: 31 });
  for (let index = 0; index < 10_000; index += 1) {
    meter.record({ type: "exec", state: "finished", durationMs: 1 });
  }

  const report = meter.report();

  expect(report.schema).toBe(1);
  expect(report.samples).toHaveLength(10);
  expect(report.samples).toContainEqual({
    type: "exec",
    state: "finished",
    count: 10_001,
    durationMs: 10_020,
  });
  expect(report.samples.map((sample) => sample.type)).toEqual([
    "cache",
    "cache",
    "exec",
    "exec",
    "loss",
    "run",
    "sandbox",
    "sandbox",
    "source",
    "source",
  ]);
  expect(JSON.stringify(report)).not.toMatch(
    /"(?:command|output|url|repository|runId|placement|secret|digest|author|price|usage|estimate)"/i,
  );
  expect(() =>
    meter.record({ type: "exec", state: "finished", durationMs: 1, command: "token" } as never),
  ).toThrow("invalid meter sample");
  expect(() =>
    meter.record({
      type: "usage",
      source: "r2",
      unit: "class-a",
      quantity: 1,
    } as never),
  ).toThrow("invalid meter sample");
});

test("aggregation rejects numeric overflow", () => {
  const meter = new Meter();
  meter.record({ type: "exec", state: "finished", durationMs: Number.MAX_SAFE_INTEGER });

  expect(() => meter.record({ type: "exec", state: "finished", durationMs: 1 })).toThrow(
    "overflow",
  );
});
