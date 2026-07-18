import type { Meter } from "./meter.ts";

export type Outcome = "success" | "failure" | "cancelled";

export interface Finalization {
  readonly claimId: string;
  readonly outcome: Outcome;
}

export interface TerminalIdentity {
  readonly accountId: string;
  readonly repositoryId: string;
  readonly workflowId: string;
  readonly runId: string;
  readonly trustId: string;
  readonly generation: number;
}

export interface TerminalRecord extends TerminalIdentity, Finalization {}

export interface TerminalState {
  claim(candidate: TerminalRecord): Promise<TerminalRecord>;
  read(): Promise<TerminalRecord | undefined>;
}

export class TerminalError extends Error {
  override readonly name = "TerminalError";
}

export class Terminal {
  readonly #identity: TerminalIdentity;
  readonly #publish: (finalization: Finalization) => Promise<void>;
  readonly #state: TerminalState;
  readonly #meter: Meter | undefined;
  readonly #started: number | undefined;
  #flushed = false;
  #reported = false;

  constructor(
    identity: TerminalIdentity,
    state: TerminalState,
    publish: (finalization: Finalization) => Promise<void>,
    options: { readonly meter?: Meter } = {},
  ) {
    this.#identity = parseTerminalIdentity(identity);
    this.#state = state;
    this.#publish = publish;
    this.#meter = options.meter;
    this.#started = options.meter?.now();
  }

  async claim(outcome: Outcome): Promise<Finalization> {
    if (!isOutcome(outcome)) throw new TerminalError("invalid terminal outcome");
    const winner = this.#record(
      await this.#state.claim({
        ...this.#identity,
        claimId: crypto.randomUUID(),
        outcome,
      }),
    );
    return { claimId: winner.claimId, outcome: winner.outcome };
  }

  async verify(finalization: Finalization): Promise<void> {
    const parsed = parseFinalization(finalization);
    const winner = await this.#state.read();
    if (!winner) throw new TerminalError("unknown terminal claim");
    const record = this.#record(winner);
    if (record.claimId !== parsed.claimId || record.outcome !== parsed.outcome) {
      throw new TerminalError("terminal finalization does not match the durable winner");
    }
  }

  async publish(finalization: Finalization): Promise<void> {
    await this.verify(finalization);
    await this.#publish(finalization);
    if (this.#meter) {
      if (!this.#reported) {
        try {
          this.#meter.record({
            type: "run",
            outcome: finalization.outcome,
            durationMs: Math.max(0, Math.round(this.#meter.now() - this.#started!)),
          });
        } catch {}
        this.#reported = true;
      }
      if (!this.#flushed) {
        await this.#meter
          .flush()
          .then(() => {
            this.#flushed = true;
          })
          .catch(() => {});
      }
    }
  }

  #record(value: TerminalRecord): TerminalRecord {
    const record = parseTerminalRecord(value);
    for (const field of identityFields) {
      if (record[field] !== this.#identity[field]) {
        throw new TerminalError("terminal claim belongs to a different authority");
      }
    }
    return record;
  }
}

const identityFields = [
  "accountId",
  "repositoryId",
  "workflowId",
  "runId",
  "trustId",
  "generation",
] as const;

const isOutcome = (value: unknown): value is Outcome =>
  value === "success" || value === "failure" || value === "cancelled";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export const parseTerminalIdentity = (value: unknown): TerminalIdentity => {
  if (!isRecord(value) || !exactKeys(value, identityFields)) {
    throw new TerminalError("invalid terminal identity");
  }
  for (const field of identityFields.slice(0, -1)) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new TerminalError("invalid terminal identity");
    }
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) {
    throw new TerminalError("invalid terminal identity");
  }
  return {
    accountId: value.accountId as string,
    repositoryId: value.repositoryId as string,
    workflowId: value.workflowId as string,
    runId: value.runId as string,
    trustId: value.trustId as string,
    generation: value.generation as number,
  };
};

export const parseFinalization = (value: unknown): Finalization => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["claimId", "outcome"]) ||
    typeof value.claimId !== "string" ||
    value.claimId.length === 0 ||
    !isOutcome(value.outcome)
  ) {
    throw new TerminalError("invalid terminal finalization");
  }
  return { claimId: value.claimId, outcome: value.outcome };
};

export const parseTerminalRecord = (value: unknown): TerminalRecord => {
  if (!isRecord(value) || !exactKeys(value, [...identityFields, "claimId", "outcome"])) {
    throw new TerminalError("invalid durable terminal record");
  }
  try {
    return {
      ...parseTerminalIdentity({
        accountId: value.accountId,
        repositoryId: value.repositoryId,
        workflowId: value.workflowId,
        runId: value.runId,
        trustId: value.trustId,
        generation: value.generation,
      }),
      ...parseFinalization({ claimId: value.claimId, outcome: value.outcome }),
    };
  } catch {
    throw new TerminalError("invalid durable terminal record");
  }
};
