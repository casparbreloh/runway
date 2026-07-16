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

  constructor(
    identity: TerminalIdentity,
    state: TerminalState,
    publish: (finalization: Finalization) => Promise<void>,
  ) {
    assertIdentity(identity);
    this.#identity = identity;
    this.#state = state;
    this.#publish = publish;
  }

  async claim(outcome: Outcome): Promise<Finalization> {
    if (!isOutcome(outcome)) throw new TerminalError("invalid terminal outcome");
    const winner = await this.#state.claim({
      ...this.#identity,
      claimId: crypto.randomUUID(),
      outcome,
    });
    this.#assertRecord(winner);
    return { claimId: winner.claimId, outcome: winner.outcome };
  }

  async verify(finalization: Finalization): Promise<void> {
    assertFinalization(finalization);
    const winner = await this.#state.read();
    if (!winner) throw new TerminalError("unknown terminal claim");
    this.#assertRecord(winner);
    if (winner.claimId !== finalization.claimId || winner.outcome !== finalization.outcome) {
      throw new TerminalError("terminal finalization does not match the durable winner");
    }
  }

  async publish(finalization: Finalization): Promise<void> {
    await this.verify(finalization);
    await this.#publish(finalization);
  }

  #assertRecord(record: TerminalRecord): void {
    assertRecord(record);
    for (const field of identityFields) {
      if (record[field] !== this.#identity[field]) {
        throw new TerminalError("terminal claim belongs to a different authority");
      }
    }
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

const assertIdentity = (identity: TerminalIdentity): void => {
  for (const field of identityFields.slice(0, -1)) {
    if (typeof identity[field] !== "string" || identity[field].length === 0) {
      throw new TerminalError("invalid terminal identity");
    }
  }
  if (!Number.isSafeInteger(identity.generation) || identity.generation < 0) {
    throw new TerminalError("invalid terminal identity");
  }
};

const assertFinalization = (value: Finalization): void => {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "claimId,outcome" ||
    typeof value.claimId !== "string" ||
    value.claimId.length === 0 ||
    !isOutcome(value.outcome)
  ) {
    throw new TerminalError("invalid terminal finalization");
  }
};

const assertRecord = (value: TerminalRecord): void => {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !==
      "accountId,claimId,generation,outcome,repositoryId,runId,trustId,workflowId"
  ) {
    throw new TerminalError("invalid durable terminal record");
  }
  assertIdentity(value);
  assertFinalization({ claimId: value.claimId, outcome: value.outcome });
};
