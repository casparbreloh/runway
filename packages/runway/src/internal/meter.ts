import type { Outcome } from "./terminal.ts";

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
  | { readonly type: "loss"; readonly startedCommands: number }
  | { readonly type: "run"; readonly outcome: Outcome; readonly durationMs: number };

export interface MeterReport {
  readonly schema: 1;
  readonly samples: ReadonlyArray<Record<string, string | number>>;
}

interface MeterOptions {
  readonly emit?: (report: MeterReport) => void | Promise<void>;
  readonly now?: () => number;
}

const keys = (value: object): string => Object.keys(value).sort().join(",");
const quantity = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => quantity(value) && Number.isSafeInteger(value);
const duration = integer;

const assertSample = (sample: Sample): void => {
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

const series = (sample: Sample): string => {
  if (sample.type === "sandbox") return `${sample.type}:${sample.phase}`;
  if (sample.type === "source" || sample.type === "exec" || sample.type === "cache") {
    return `${sample.type}:${sample.state}`;
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
    if (!integer(value)) throw new Error("meter quantity overflow");
    return value;
  };
  if (sample.type === "loss") {
    return {
      type: "loss",
      startedCommands: sum(Number(previous?.startedCommands ?? 0), sample.startedCommands),
    };
  }
  const count = sum(Number(previous?.count ?? 0), 1);
  if (sample.type === "sandbox") {
    return {
      type: sample.type,
      phase: sample.phase,
      count,
      durationMs: sum(Number(previous?.durationMs ?? 0), sample.durationMs),
    };
  }
  if (sample.type === "source" || sample.type === "cache") {
    return {
      type: sample.type,
      state: sample.state,
      count,
      durationMs: sum(Number(previous?.durationMs ?? 0), sample.durationMs),
      bytes: sum(Number(previous?.bytes ?? 0), sample.bytes),
    };
  }
  if (sample.type === "exec") {
    return {
      type: sample.type,
      state: sample.state,
      count,
      durationMs: sum(Number(previous?.durationMs ?? 0), sample.durationMs),
    };
  }
  return {
    type: "run",
    outcome: sample.outcome,
    count,
    durationMs: sum(Number(previous?.durationMs ?? 0), sample.durationMs),
  };
};

export class Meter {
  readonly #emit: MeterOptions["emit"];
  readonly #now: () => number;
  readonly #samples = new Map<string, Record<string, string | number>>();

  constructor(options: MeterOptions = {}) {
    this.#emit = options.emit;
    this.#now = options.now ?? (() => performance.now());
  }

  now(): number {
    return this.#now();
  }

  record(sample: Sample): void {
    assertSample(sample);
    const key = series(sample);
    this.#samples.set(key, aggregate(this.#samples.get(key), sample));
  }

  report(): MeterReport {
    const samples = [...this.#samples.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, sample]) => ({ ...sample }));
    return { schema: 1, samples };
  }

  async flush(): Promise<MeterReport> {
    const report = this.report();
    await this.#emit?.(report);
    return report;
  }
}
