import { expect, test } from "vitest";

import {
  CLOUDFLARE_PRICE_TABLE,
  CLOUDFLARE_PRICE_TABLE_2026_08_10,
  Meter,
  estimate,
  type PriceTable,
} from "../src/internal/meter.ts";

const prices = (id: string, multiplier = 1): PriceTable => ({
  id,
  rates: [
    { source: "container", unit: "vcpu-ms", usdPerUnit: 2e-8 * multiplier },
    { source: "container", unit: "gib-ms", usdPerUnit: 2.5e-9 * multiplier },
    { source: "container", unit: "disk-gb-ms", usdPerUnit: 7e-11 * multiplier },
    { source: "container", unit: "egress-byte", usdPerUnit: (0.05 / 1e9) * multiplier },
    { source: "r2", unit: "class-a", usdPerUnit: 4.5e-6 * multiplier },
    { source: "r2", unit: "class-b", usdPerUnit: 3.6e-7 * multiplier },
    {
      source: "r2",
      unit: "stored-byte-ms",
      usdPerUnit: multiplier * (0.015 / 1e9 / 2_592_000_000),
    },
    { source: "r2", unit: "egress-byte", usdPerUnit: 0 },
    { source: "workflow", unit: "step", usdPerUnit: 0 },
  ],
});

test("a bounded structured report distinguishes every run phase without cardinality labels", () => {
  const meter = new Meter({ priceTable: prices("test-prices-v1") });
  meter.record({ type: "sandbox", phase: "ready", durationMs: 11 });
  meter.record({ type: "sandbox", phase: "destroy", durationMs: 3 });
  meter.record({ type: "source", state: "prepared", durationMs: 7, bytes: 100 });
  meter.record({ type: "source", state: "reused", durationMs: 1, bytes: 0 });
  meter.record({ type: "exec", state: "finished", durationMs: 20 });
  meter.record({ type: "exec", state: "reconnected", durationMs: 20 });
  meter.record({ type: "cache", state: "miss", durationMs: 4, bytes: 0 });
  meter.record({ type: "cache", state: "hit", durationMs: 2, bytes: 50 });
  meter.record({ type: "tool", state: "prepared", durationMs: 6 });
  meter.record({
    type: "transfer",
    operation: "get",
    state: "finished",
    durationMs: 5,
    bytes: 80,
  });
  meter.record({ type: "loss", startedCommands: 2 });
  meter.record({ type: "run", outcome: "failure", durationMs: 31 });
  for (let index = 0; index < 10_000; index += 1) {
    meter.record({ type: "exec", state: "finished", durationMs: 1 });
  }

  const report = meter.report();

  expect(report.schema).toBe(1);
  expect(report.samples).toHaveLength(12);
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
    "tool",
    "transfer",
  ]);
  expect(JSON.stringify(report)).not.toMatch(
    /"(?:command|output|url|repository|runId|placement|secret|digest|author)"/i,
  );
  expect(() =>
    meter.record({ type: "exec", state: "finished", durationMs: 1, command: "token" } as never),
  ).toThrow("invalid meter sample");
});

test("billable quantities retain explicit provenance and immutable price identity", () => {
  const meter = new Meter({ priceTable: prices("test-prices-v1") });
  meter.record({
    type: "usage",
    source: "r2",
    unit: "class-a",
    quantity: 2,
    priceTableId: "test-prices-v1",
    provenance: "provider-aggregate",
  });
  meter.record({
    type: "usage",
    source: "container",
    unit: "vcpu-ms",
    quantity: 500,
    priceTableId: "test-prices-v1",
    provenance: "allocated",
  });

  expect(meter.report()).toMatchObject({
    priceTableId: "test-prices-v1",
    samples: expect.arrayContaining([
      {
        type: "usage",
        source: "r2",
        unit: "class-a",
        quantity: 2,
        priceTableId: "test-prices-v1",
        provenance: "provider-aggregate",
      },
      {
        type: "usage",
        source: "container",
        unit: "vcpu-ms",
        quantity: 500,
        priceTableId: "test-prices-v1",
        provenance: "allocated",
      },
    ]),
  });
  expect(() =>
    meter.record({
      type: "usage",
      source: "r2",
      unit: "class-a",
      quantity: 1,
      priceTableId: "another-table",
      provenance: "provider",
    }),
  ).toThrow("price table");
  expect(() =>
    meter.record({
      type: "usage",
      source: "container",
      unit: "class-a",
      quantity: 1,
      priceTableId: "test-prices-v1",
      provenance: "provider",
    }),
  ).toThrow("invalid meter sample");

  const aggregate = new Meter({ priceTable: prices("aggregate-overflow") });
  aggregate.record({ type: "exec", state: "finished", durationMs: Number.MAX_SAFE_INTEGER });
  expect(() => aggregate.record({ type: "exec", state: "finished", durationMs: 1 })).toThrow(
    "overflow",
  );
});

test("a new price table reprices only the retained raw quantities", () => {
  const raw = [
    {
      type: "usage" as const,
      source: "r2" as const,
      unit: "class-a" as const,
      quantity: 3,
      priceTableId: "test-prices-v1",
      provenance: "provider" as const,
    },
    {
      type: "usage" as const,
      source: "container" as const,
      unit: "vcpu-ms" as const,
      quantity: 200,
      priceTableId: "test-prices-v1",
      provenance: "derived" as const,
    },
  ];

  expect(estimate(raw, prices("test-prices-v1"))).toEqual({
    priceTableId: "test-prices-v1",
    usd: 0.0000175,
  });
  expect(estimate(raw, prices("test-prices-v2", 2))).toEqual({
    priceTableId: "test-prices-v2",
    usd: 0.000035,
  });
});

test("current and scheduled Workflow billing remain separate price identities", () => {
  const usage = [
    {
      type: "usage" as const,
      source: "workflow" as const,
      unit: "step" as const,
      quantity: 100_000,
      priceTableId: CLOUDFLARE_PRICE_TABLE.id,
      provenance: "derived" as const,
    },
  ];

  expect(estimate(usage, CLOUDFLARE_PRICE_TABLE)).toEqual({
    priceTableId: "cloudflare-current-usd-2026-07-16",
    usd: 0,
  });
  expect(estimate(usage, CLOUDFLARE_PRICE_TABLE_2026_08_10)).toMatchObject({
    priceTableId: "cloudflare-scheduled-usd-2026-08-10",
    usd: expect.closeTo(0.8),
  });
  expect(Object.isFrozen(CLOUDFLARE_PRICE_TABLE.rates[0])).toBe(true);
  expect(CLOUDFLARE_PRICE_TABLE.rates).toContainEqual({
    source: "container",
    unit: "egress-byte",
    usdPerUnit: 0.05 / 1e9,
  });
  expect(CLOUDFLARE_PRICE_TABLE.rates).toContainEqual({
    source: "durable-object",
    unit: "gb-ms",
    usdPerUnit: 12.5 / 1_000_000 / 1_000,
  });
  expect(() => {
    (CLOUDFLARE_PRICE_TABLE.rates[0] as { usdPerUnit: number }).usdPerUnit = 99;
  }).toThrow();
});

test("cache admission is priced by the same estimator from a conservative raw bound", () => {
  const meter = new Meter({
    priceTable: prices("test-prices-v1"),
    container: { vcpu: 0.5, memoryGib: 4, diskGb: 8 },
    cache: {
      maxBytes: 1_000_000,
      maxDurationMs: 1_000,
      save: {
        classAOperations: 9,
        classBOperations: 10,
        storageHorizonMs: 30 * 24 * 60 * 60 * 1_000,
        transferDurationMs: 300,
        workflowSteps: 3,
      },
      restore: {
        classAOperations: 0,
        classBOperations: 4,
        transferDurationMs: 300,
        workflowSteps: 1,
      },
    },
  });

  const bound = meter.cacheBound({});

  expect(bound.samples).toEqual([
    {
      type: "usage",
      source: "container",
      unit: "vcpu-ms",
      quantity: 650,
      priceTableId: "test-prices-v1",
      provenance: "allocated",
    },
    {
      type: "usage",
      source: "container",
      unit: "gib-ms",
      quantity: 5_200,
      priceTableId: "test-prices-v1",
      provenance: "allocated",
    },
    {
      type: "usage",
      source: "container",
      unit: "disk-gb-ms",
      quantity: 10_400,
      priceTableId: "test-prices-v1",
      provenance: "allocated",
    },
    {
      type: "usage",
      source: "r2",
      unit: "class-a",
      quantity: 9,
      priceTableId: "test-prices-v1",
      provenance: "derived",
    },
    {
      type: "usage",
      source: "workflow",
      unit: "step",
      quantity: 3,
      priceTableId: "test-prices-v1",
      provenance: "derived",
    },
    {
      type: "usage",
      source: "r2",
      unit: "class-b",
      quantity: 10,
      priceTableId: "test-prices-v1",
      provenance: "derived",
    },
    {
      type: "usage",
      source: "r2",
      unit: "stored-byte-ms",
      quantity: 2_592_000_000_000_000,
      priceTableId: "test-prices-v1",
      provenance: "allocated",
    },
  ]);
  expect(bound.estimate).toEqual(estimate(bound.samples, prices("test-prices-v1")));
});

test("fractional allocation and separate restore transfer bounds remain measurable", () => {
  const table = prices("fractional");
  const meter = new Meter({
    priceTable: table,
    container: { vcpu: 0.0625, memoryGib: 0.25, diskGb: 2 },
    cache: {
      maxBytes: 10,
      maxDurationMs: 1,
      save: {
        classAOperations: 9,
        classBOperations: 10,
        storageHorizonMs: 1,
        transferDurationMs: 1,
        workflowSteps: 3,
      },
      restore: {
        classAOperations: 0,
        classBOperations: 4,
        transferDurationMs: 2,
        workflowSteps: 1,
      },
    },
  });

  expect(meter.cacheBound({}).samples[0]).toMatchObject({ quantity: 0.125 });
  expect(meter.cacheRestoreBound({}).samples).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: "container", unit: "vcpu-ms", quantity: 0.1875 }),
      expect.objectContaining({ source: "r2", unit: "class-b", quantity: 4 }),
      expect.objectContaining({ source: "workflow", unit: "step", quantity: 1 }),
    ]),
  );
});

test("pricing rejects ambiguous or incomplete tables and numeric overflow", () => {
  const duplicate = prices("duplicate");
  expect(
    () =>
      new Meter({ priceTable: { ...duplicate, rates: [...duplicate.rates, duplicate.rates[0]!] } }),
  ).toThrow("invalid price table");
  expect(() =>
    estimate(
      [
        {
          type: "usage",
          source: "r2",
          unit: "class-a",
          quantity: 1,
          priceTableId: "partial",
          provenance: "provider",
        },
      ],
      { id: "partial", rates: [] },
    ),
  ).toThrow("does not cover");

  const meter = new Meter({ priceTable: prices("overflow") });
  meter.record({
    type: "usage",
    source: "r2",
    unit: "class-a",
    quantity: Number.MAX_VALUE,
    priceTableId: "overflow",
    provenance: "provider",
  });
  expect(() =>
    meter.record({
      type: "usage",
      source: "r2",
      unit: "class-a",
      quantity: Number.MAX_VALUE,
      priceTableId: "overflow",
      provenance: "provider",
    }),
  ).toThrow("overflow");
  expect(() =>
    meter.record({
      type: "usage",
      source: "r2",
      unit: "class-a",
      quantity: Number.POSITIVE_INFINITY,
      priceTableId: "overflow",
      provenance: "provider",
    }),
  ).toThrow("invalid meter sample");
});
