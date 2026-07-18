import type { Outcome } from "./terminal.ts";

export type UsageSource = "container" | "r2" | "worker" | "workflow" | "durable-object";

export type UsageUnit =
  | "vcpu-ms"
  | "gib-ms"
  | "gb-ms"
  | "disk-gb-ms"
  | "class-a"
  | "class-b"
  | "stored-byte-ms"
  | "egress-byte"
  | "request"
  | "step";

export type Provenance = "provider" | "provider-aggregate" | "derived" | "allocated";

export type UsageSample = {
  readonly type: "usage";
  readonly source: UsageSource;
  readonly quantity: number;
  readonly unit: UsageUnit;
  readonly priceTableId: string;
  readonly provenance: Provenance;
};

export type Sample =
  | { readonly type: "sandbox"; readonly phase: "ready" | "destroy"; readonly durationMs: number }
  | {
      readonly type: "source";
      readonly state: "prepared" | "reused";
      readonly durationMs: number;
      readonly bytes: number;
    }
  | {
      readonly type: "exec";
      readonly state: "finished" | "reconnected";
      readonly durationMs: number;
    }
  | {
      readonly type: "cache";
      readonly state: "hit" | "miss" | "saved" | "skipped";
      readonly durationMs: number;
      readonly bytes: number;
    }
  | {
      readonly type: "tool";
      readonly state: "prepared" | "failed";
      readonly durationMs: number;
    }
  | {
      readonly type: "transfer";
      readonly operation: "get" | "put";
      readonly state: "finished" | "present";
      readonly durationMs: number;
      readonly bytes: number;
    }
  | UsageSample
  | { readonly type: "loss"; readonly startedCommands: number }
  | { readonly type: "run"; readonly outcome: Outcome; readonly durationMs: number };

export interface PriceTable {
  readonly id: string;
  readonly rates: ReadonlyArray<{
    readonly source: UsageSource;
    readonly unit: UsageUnit;
    readonly usdPerUnit: number;
  }>;
}

export interface MeterReport {
  readonly schema: 1;
  readonly priceTableId: string;
  readonly samples: ReadonlyArray<Record<string, string | number>>;
  readonly estimate: { readonly priceTableId: string; readonly usd: number };
}

export const emitMeterReport = (report: MeterReport): void =>
  console.log(JSON.stringify({ type: "runway-meter", report }));

interface CacheBoundOptions {
  readonly maxBytes?: number;
  readonly maxDurationMs?: number;
}

interface MeterOptions {
  readonly priceTable: PriceTable;
  readonly container?: {
    readonly vcpu: number;
    readonly memoryGib: number;
    readonly diskGb: number;
  };
  readonly cache?: {
    readonly maxBytes: number;
    readonly maxDurationMs: number;
    readonly save: {
      readonly classAOperations: number;
      readonly classBOperations: number;
      readonly storageHorizonMs: number;
      readonly transferDurationMs: number;
      readonly workflowSteps: number;
    };
    readonly restore: {
      readonly classAOperations: number;
      readonly classBOperations: number;
      readonly transferDurationMs: number;
      readonly workflowSteps: number;
    };
  };
  readonly emit?: (report: MeterReport) => void | Promise<void>;
  readonly now?: () => number;
}

export const CLOUDFLARE_PRICE_TABLE: PriceTable = Object.freeze({
  id: "cloudflare-current-usd-2026-07-16",
  rates: Object.freeze([
    { source: "container", unit: "vcpu-ms", usdPerUnit: 0.00002 / 1_000 },
    { source: "container", unit: "gib-ms", usdPerUnit: 0.0000025 / 1_000 },
    { source: "container", unit: "disk-gb-ms", usdPerUnit: 0.00000007 / 1_000 },
    { source: "container", unit: "egress-byte", usdPerUnit: 0.05 / 1e9 },
    { source: "r2", unit: "class-a", usdPerUnit: 4.5 / 1_000_000 },
    { source: "r2", unit: "class-b", usdPerUnit: 0.36 / 1_000_000 },
    { source: "r2", unit: "stored-byte-ms", usdPerUnit: 0.015 / 1e9 / 2_592_000_000 },
    { source: "r2", unit: "egress-byte", usdPerUnit: 0 },
    { source: "worker", unit: "vcpu-ms", usdPerUnit: 0.02 / 1_000_000 },
    { source: "worker", unit: "request", usdPerUnit: 0.3 / 1_000_000 },
    { source: "workflow", unit: "vcpu-ms", usdPerUnit: 0.02 / 1_000_000 },
    { source: "workflow", unit: "request", usdPerUnit: 0.3 / 1_000_000 },
    { source: "workflow", unit: "step", usdPerUnit: 0 },
    {
      source: "workflow",
      unit: "stored-byte-ms",
      usdPerUnit: 0,
    },
    { source: "durable-object", unit: "gb-ms", usdPerUnit: 12.5 / 1_000_000 / 1_000 },
    { source: "durable-object", unit: "request", usdPerUnit: 0.15 / 1_000_000 },
    {
      source: "durable-object",
      unit: "stored-byte-ms",
      usdPerUnit: 0.2 / 1e9 / 2_592_000_000,
    },
  ]),
} satisfies PriceTable);
for (const rate of CLOUDFLARE_PRICE_TABLE.rates) Object.freeze(rate);

export const CLOUDFLARE_PRICE_TABLE_2026_08_10: PriceTable = Object.freeze({
  id: "cloudflare-scheduled-usd-2026-08-10",
  rates: Object.freeze(
    CLOUDFLARE_PRICE_TABLE.rates.map((rate) => {
      if (rate.source === "workflow" && rate.unit === "step") {
        return { ...rate, usdPerUnit: 0.8 / 100_000 };
      }
      if (rate.source === "workflow" && rate.unit === "stored-byte-ms") {
        return { ...rate, usdPerUnit: 0.2 / 1e9 / 2_592_000_000 };
      }
      return rate;
    }),
  ),
} satisfies PriceTable);
for (const rate of CLOUDFLARE_PRICE_TABLE_2026_08_10.rates) Object.freeze(rate);

const sources = ["container", "r2", "worker", "workflow", "durable-object"] as const;
const units = [
  "vcpu-ms",
  "gib-ms",
  "gb-ms",
  "disk-gb-ms",
  "class-a",
  "class-b",
  "stored-byte-ms",
  "egress-byte",
  "request",
  "step",
] as const;
const provenance = ["provider", "provider-aggregate", "derived", "allocated"] as const;

const allowedUnits: Readonly<Record<UsageSource, ReadonlySet<UsageUnit>>> = {
  container: new Set(["vcpu-ms", "gib-ms", "disk-gb-ms", "egress-byte", "request"]),
  r2: new Set(["class-a", "class-b", "stored-byte-ms", "egress-byte"]),
  worker: new Set(["vcpu-ms", "request"]),
  workflow: new Set(["vcpu-ms", "request", "step", "stored-byte-ms"]),
  "durable-object": new Set(["gb-ms", "request", "stored-byte-ms"]),
};

const keys = (value: object): string => Object.keys(value).sort().join(",");
const quantity = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => quantity(value) && Number.isSafeInteger(value);
const duration = integer;

const validId = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 128
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
};

const assertPriceTable = (table: PriceTable): Map<string, number> => {
  if (!table || typeof table !== "object" || keys(table) !== "id,rates" || !validId(table.id)) {
    throw new Error("invalid price table");
  }
  if (!Array.isArray(table.rates)) throw new Error("invalid price table");
  const result = new Map<string, number>();
  for (const rate of table.rates) {
    const source = rate?.source as UsageSource;
    const unit = rate?.unit as UsageUnit;
    if (
      !rate ||
      typeof rate !== "object" ||
      keys(rate) !== "source,unit,usdPerUnit" ||
      !sources.includes(source) ||
      !units.includes(unit) ||
      !allowedUnits[source]?.has(unit) ||
      !Number.isFinite(rate.usdPerUnit) ||
      rate.usdPerUnit < 0
    ) {
      throw new Error("invalid price table");
    }
    const key = `${rate.source}:${rate.unit}`;
    if (result.has(key)) throw new Error("invalid price table");
    result.set(key, rate.usdPerUnit);
  }
  return result;
};

const assertSample = (sample: Sample, priceTableId?: string): void => {
  if (!sample || typeof sample !== "object" || !("type" in sample)) {
    throw new Error("invalid meter sample");
  }
  if (sample.type === "sandbox") {
    if (
      keys(sample) !== "durationMs,phase,type" ||
      !["ready", "destroy"].includes(sample.phase) ||
      !duration(sample.durationMs)
    )
      throw new Error("invalid meter sample");
    return;
  }
  if (sample.type === "source") {
    if (
      keys(sample) !== "bytes,durationMs,state,type" ||
      !["prepared", "reused"].includes(sample.state) ||
      !duration(sample.durationMs) ||
      !integer(sample.bytes)
    )
      throw new Error("invalid meter sample");
    return;
  }
  if (sample.type === "exec") {
    if (
      keys(sample) !== "durationMs,state,type" ||
      !["finished", "reconnected"].includes(sample.state) ||
      !duration(sample.durationMs)
    )
      throw new Error("invalid meter sample");
    return;
  }
  if (sample.type === "cache") {
    if (
      keys(sample) !== "bytes,durationMs,state,type" ||
      !["hit", "miss", "saved", "skipped"].includes(sample.state) ||
      !duration(sample.durationMs) ||
      !integer(sample.bytes)
    )
      throw new Error("invalid meter sample");
    return;
  }
  if (sample.type === "tool") {
    if (
      keys(sample) !== "durationMs,state,type" ||
      !["prepared", "failed"].includes(sample.state) ||
      !duration(sample.durationMs)
    )
      throw new Error("invalid meter sample");
    return;
  }
  if (sample.type === "transfer") {
    if (
      keys(sample) !== "bytes,durationMs,operation,state,type" ||
      !["get", "put"].includes(sample.operation) ||
      !["finished", "present"].includes(sample.state) ||
      (sample.operation === "get" && sample.state !== "finished") ||
      !duration(sample.durationMs) ||
      !integer(sample.bytes)
    )
      throw new Error("invalid meter sample");
    return;
  }
  if (sample.type === "usage") {
    const source = sample.source as UsageSource;
    const unit = sample.unit as UsageUnit;
    if (
      keys(sample) !== "priceTableId,provenance,quantity,source,type,unit" ||
      !sources.includes(source) ||
      !units.includes(unit) ||
      !allowedUnits[source]?.has(unit) ||
      !quantity(sample.quantity) ||
      !validId(sample.priceTableId) ||
      !provenance.includes(sample.provenance)
    )
      throw new Error("invalid meter sample");
    if (priceTableId !== undefined && sample.priceTableId !== priceTableId) {
      throw new Error("meter sample has a different price table");
    }
    return;
  }
  if (sample.type === "loss") {
    if (keys(sample) !== "startedCommands,type" || !integer(sample.startedCommands)) {
      throw new Error("invalid meter sample");
    }
    return;
  }
  if (sample.type === "run") {
    if (
      keys(sample) !== "durationMs,outcome,type" ||
      !["success", "failure", "cancelled"].includes(sample.outcome) ||
      !duration(sample.durationMs)
    )
      throw new Error("invalid meter sample");
    return;
  }
  throw new Error("invalid meter sample");
};

export const estimate = (
  samples: readonly UsageSample[],
  priceTable: PriceTable,
): { readonly priceTableId: string; readonly usd: number } => {
  const rates = assertPriceTable(priceTable);
  let usd = 0;
  for (const sample of samples) {
    assertSample(sample);
    const rate = rates.get(`${sample.source}:${sample.unit}`);
    if (rate === undefined) throw new Error("price table does not cover meter usage");
    usd += sample.quantity * rate;
    if (!Number.isFinite(usd)) throw new Error("meter estimate overflow");
  }
  return { priceTableId: priceTable.id, usd };
};

const series = (sample: Sample): string => {
  if (sample.type === "sandbox") return `${sample.type}:${sample.phase}`;
  if (sample.type === "source" || sample.type === "exec" || sample.type === "cache") {
    return `${sample.type}:${sample.state}`;
  }
  if (sample.type === "tool") return `${sample.type}:${sample.state}`;
  if (sample.type === "transfer") {
    return `${sample.type}:${sample.operation}:${sample.state}`;
  }
  if (sample.type === "usage") {
    return `${sample.type}:${sample.source}:${sample.unit}:${sample.priceTableId}:${sample.provenance}`;
  }
  if (sample.type === "run") return `${sample.type}:${sample.outcome}`;
  return sample.type;
};

const aggregate = (
  previous: Record<string, string | number> | undefined,
  sample: Sample,
): Record<string, string | number> => {
  const sum = (left: number, right: number): number => {
    const value = left + right;
    if (!quantity(value)) throw new Error("meter quantity overflow");
    return value;
  };
  const sumInteger = (left: number, right: number): number => {
    const value = sum(left, right);
    if (!integer(value)) throw new Error("meter quantity overflow");
    return value;
  };
  if (sample.type === "usage") {
    return {
      ...sample,
      quantity: sum(Number(previous?.quantity ?? 0), sample.quantity),
    };
  }
  if (sample.type === "loss") {
    return {
      type: "loss",
      startedCommands: sumInteger(Number(previous?.startedCommands ?? 0), sample.startedCommands),
    };
  }
  const count = sumInteger(Number(previous?.count ?? 0), 1);
  if (sample.type === "sandbox") {
    return {
      type: sample.type,
      phase: sample.phase,
      count,
      durationMs: sumInteger(Number(previous?.durationMs ?? 0), sample.durationMs),
    };
  }
  if (sample.type === "source" || sample.type === "cache") {
    return {
      type: sample.type,
      state: sample.state,
      count,
      durationMs: sumInteger(Number(previous?.durationMs ?? 0), sample.durationMs),
      bytes: sumInteger(Number(previous?.bytes ?? 0), sample.bytes),
    };
  }
  if (sample.type === "exec") {
    return {
      type: sample.type,
      state: sample.state,
      count,
      durationMs: sumInteger(Number(previous?.durationMs ?? 0), sample.durationMs),
    };
  }
  if (sample.type === "tool") {
    return {
      type: sample.type,
      state: sample.state,
      count,
      durationMs: sumInteger(Number(previous?.durationMs ?? 0), sample.durationMs),
    };
  }
  if (sample.type === "transfer") {
    return {
      type: sample.type,
      operation: sample.operation,
      state: sample.state,
      count,
      durationMs: sumInteger(Number(previous?.durationMs ?? 0), sample.durationMs),
      bytes: sumInteger(Number(previous?.bytes ?? 0), sample.bytes),
    };
  }
  return {
    type: "run",
    outcome: sample.outcome,
    count,
    durationMs: sumInteger(Number(previous?.durationMs ?? 0), sample.durationMs),
  };
};

export class Meter {
  readonly #cache: MeterOptions["cache"];
  readonly #container: MeterOptions["container"];
  readonly #emit: MeterOptions["emit"];
  readonly #now: () => number;
  readonly #priceTable: PriceTable;
  readonly #samples = new Map<string, Record<string, string | number>>();

  constructor(options: MeterOptions) {
    assertPriceTable(options.priceTable);
    this.#priceTable = structuredClone(options.priceTable);
    this.#container = options.container && structuredClone(options.container);
    this.#cache = options.cache && structuredClone(options.cache);
    this.#emit = options.emit;
    this.#now = options.now ?? (() => performance.now());
    if (this.#cache && !this.#container) throw new Error("cache meter requires explicit capacity");
    if (this.#container) {
      for (const value of Object.values(this.#container)) {
        if (!Number.isFinite(value) || value < 0) throw new Error("invalid meter capacity");
      }
    }
    if (this.#cache) {
      const values = [
        this.#cache.maxBytes,
        this.#cache.maxDurationMs,
        ...Object.values(this.#cache.save),
        ...Object.values(this.#cache.restore),
      ];
      for (const value of values) {
        if (!integer(value)) throw new Error("invalid cache meter bound");
      }
    }
  }

  now(): number {
    return this.#now();
  }

  record(sample: Sample): void {
    assertSample(sample, this.#priceTable.id);
    const key = series(sample);
    this.#samples.set(key, aggregate(this.#samples.get(key), sample));
  }

  usage(source: UsageSource, unit: UsageUnit, quantity: number, provenance: Provenance): void {
    this.record({
      type: "usage",
      source,
      unit,
      quantity,
      priceTableId: this.#priceTable.id,
      provenance,
    });
  }

  allocation(durationMs: number): void {
    if (!this.#container || !integer(durationMs)) throw new Error("invalid meter allocation");
    this.usage("container", "vcpu-ms", durationMs * this.#container.vcpu, "allocated");
    this.usage("container", "gib-ms", durationMs * this.#container.memoryGib, "allocated");
    this.usage("container", "disk-gb-ms", durationMs * this.#container.diskGb, "allocated");
  }

  cacheStorage(bytes: number): void {
    if (!this.#cache || !integer(bytes)) throw new Error("invalid cache meter storage");
    this.usage("r2", "stored-byte-ms", bytes * this.#cache.save.storageHorizonMs, "allocated");
  }

  report(priceTable: PriceTable = this.#priceTable): MeterReport {
    const samples = [...this.#samples.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, sample]) => ({ ...sample }));
    const usage = samples.filter((sample): sample is UsageSample => sample.type === "usage");
    return {
      schema: 1,
      priceTableId: this.#priceTable.id,
      samples,
      estimate: estimate(usage, priceTable),
    };
  }

  async flush(): Promise<MeterReport> {
    const report = this.report();
    await this.#emit?.(report);
    return report;
  }

  cacheBound(options: CacheBoundOptions): {
    readonly samples: readonly UsageSample[];
    readonly estimate: { readonly priceTableId: string; readonly usd: number };
  } {
    if (!this.#container || !this.#cache) throw new Error("cache meter is unavailable");
    const maxBytes = options.maxBytes ?? this.#cache.maxBytes;
    const helperDurationMs = options.maxDurationMs ?? this.#cache.maxDurationMs;
    if (!integer(maxBytes) || !integer(helperDurationMs))
      throw new Error("invalid cache meter bound");
    const maxDurationMs = helperDurationMs + this.#cache.save.transferDurationMs;
    if (!integer(maxDurationMs)) throw new Error("cache meter quantity overflow");
    const table = this.#priceTable.id;
    const samples: UsageSample[] = [
      {
        type: "usage",
        source: "container",
        unit: "vcpu-ms",
        quantity: maxDurationMs * this.#container.vcpu,
        priceTableId: table,
        provenance: "allocated",
      },
      {
        type: "usage",
        source: "container",
        unit: "gib-ms",
        quantity: maxDurationMs * this.#container.memoryGib,
        priceTableId: table,
        provenance: "allocated",
      },
      {
        type: "usage",
        source: "container",
        unit: "disk-gb-ms",
        quantity: maxDurationMs * this.#container.diskGb,
        priceTableId: table,
        provenance: "allocated",
      },
      {
        type: "usage",
        source: "r2",
        unit: "class-a",
        quantity: this.#cache.save.classAOperations,
        priceTableId: table,
        provenance: "derived",
      },
      {
        type: "usage",
        source: "workflow",
        unit: "step",
        quantity: this.#cache.save.workflowSteps,
        priceTableId: table,
        provenance: "derived",
      },
      {
        type: "usage",
        source: "r2",
        unit: "class-b",
        quantity: this.#cache.save.classBOperations,
        priceTableId: table,
        provenance: "derived",
      },
      {
        type: "usage",
        source: "r2",
        unit: "stored-byte-ms",
        quantity: maxBytes * this.#cache.save.storageHorizonMs,
        priceTableId: table,
        provenance: "allocated",
      },
    ];
    for (const sample of samples) assertSample(sample, table);
    return { samples, estimate: estimate(samples, this.#priceTable) };
  }

  cacheRestoreBound(options: CacheBoundOptions): {
    readonly samples: readonly UsageSample[];
    readonly estimate: { readonly priceTableId: string; readonly usd: number };
  } {
    if (!this.#container || !this.#cache) throw new Error("cache meter is unavailable");
    const maxBytes = options.maxBytes ?? this.#cache.maxBytes;
    const helperDurationMs = options.maxDurationMs ?? this.#cache.maxDurationMs;
    if (!integer(maxBytes) || !integer(helperDurationMs))
      throw new Error("invalid cache meter bound");
    const maxDurationMs = helperDurationMs + this.#cache.restore.transferDurationMs;
    if (!integer(maxDurationMs)) throw new Error("cache meter quantity overflow");
    const table = this.#priceTable.id;
    const samples: UsageSample[] = [
      {
        type: "usage",
        source: "container",
        unit: "vcpu-ms",
        quantity: maxDurationMs * this.#container.vcpu,
        priceTableId: table,
        provenance: "allocated",
      },
      {
        type: "usage",
        source: "container",
        unit: "gib-ms",
        quantity: maxDurationMs * this.#container.memoryGib,
        priceTableId: table,
        provenance: "allocated",
      },
      {
        type: "usage",
        source: "container",
        unit: "disk-gb-ms",
        quantity: maxDurationMs * this.#container.diskGb,
        priceTableId: table,
        provenance: "allocated",
      },
      {
        type: "usage",
        source: "r2",
        unit: "class-a",
        quantity: this.#cache.restore.classAOperations,
        priceTableId: table,
        provenance: "derived",
      },
      {
        type: "usage",
        source: "r2",
        unit: "class-b",
        quantity: this.#cache.restore.classBOperations,
        priceTableId: table,
        provenance: "derived",
      },
      {
        type: "usage",
        source: "workflow",
        unit: "step",
        quantity: this.#cache.restore.workflowSteps,
        priceTableId: table,
        provenance: "derived",
      },
    ];
    for (const sample of samples) assertSample(sample, table);
    return { samples, estimate: estimate(samples, this.#priceTable) };
  }
}
