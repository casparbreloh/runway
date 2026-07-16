export interface SourceResult {
  readonly revision: string;
  readonly state: "prepared" | "reused";
  readonly bytes: number;
}

export interface SourceIdentity {
  readonly repositoryId: string;
  readonly remote: string;
  readonly revision: string;
}

export interface Source extends SourceIdentity {
  prepare(): Promise<SourceResult>;
}

export interface SourceTransport {
  prepare(source: SourceIdentity): Promise<SourceResult>;
}

const exactRevision = (revision: string): string => {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error("source revision must be an exact 40-character lowercase Git object id");
  }
  return revision;
};

const repositoryRemote = (remote: string): string => {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw new Error("source remote must be credential-free HTTPS");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("source remote must be credential-free HTTPS");
  }
  return url.toString().replace(/\/$/, "");
};

export const source = (
  input: {
    readonly repositoryId: string;
    readonly remote: string;
    readonly revision: string;
  },
  transport: SourceTransport,
): Source => {
  if (!input.repositoryId) throw new Error("source repositoryId must not be empty");
  const revision = exactRevision(input.revision);
  const remote = repositoryRemote(input.remote);
  const identity = { repositoryId: input.repositoryId, remote, revision };
  return {
    ...identity,
    async prepare() {
      const result: unknown = await transport.prepare(identity);
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        throw new Error("source preparation result is invalid");
      }
      const record = result as Record<string, unknown>;
      if (Object.keys(record).sort().join(",") !== "bytes,revision,state") {
        throw new Error("source preparation result is invalid");
      }
      if (record.revision !== revision) {
        throw new Error("source preparation did not produce the exact revision");
      }
      if (
        (record.state !== "prepared" && record.state !== "reused") ||
        typeof record.bytes !== "number" ||
        !Number.isSafeInteger(record.bytes) ||
        record.bytes < 0
      ) {
        throw new Error("source preparation result is invalid");
      }
      return {
        revision,
        state: record.state,
        bytes: record.bytes,
      };
    },
  };
};
