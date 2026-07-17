import { AwsClient } from "aws4fetch";

const MAX_CAPABILITY_SECONDS = 5 * 60;
const SHA256 = /^[0-9a-f]{64}$/;

export interface CacheTransferCapability {
  readonly method: "GET" | "PUT";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAtMs: number;
}

interface ArchiveEvidence {
  readonly bytes: number;
  readonly digest: string;
}

export interface CacheTransferSession {
  inspect(path: string): Promise<ArchiveEvidence>;
  upload(request: {
    readonly path: string;
    readonly capability: CacheTransferCapability;
  }): Promise<"stored" | "precondition-failed">;
  download(request: {
    readonly path: string;
    readonly capability: CacheTransferCapability;
  }): Promise<ArchiveEvidence>;
  close(): Promise<void>;
}

interface CacheTransferTransport {
  quiesce(): Promise<CacheTransferSession>;
}

interface CacheObjects {
  head(key: string): Promise<ArchiveEvidence | undefined>;
}

interface CacheTransferLog {
  readonly operation: "get" | "put";
  readonly state: "finished" | "present";
  readonly durationMs: number;
  readonly bytes: number;
}

interface CloudflareCacheTransferOptions {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiresInSeconds: number;
  readonly transport: CacheTransferTransport;
  readonly objects: CacheObjects;
  readonly now?: () => Date;
  readonly log?: (entry: CacheTransferLog) => void;
}

interface TransferRequest {
  readonly runId: string;
  readonly key: string;
  readonly path: string;
}

export class CacheTransferError extends Error {
  override readonly name = "CacheTransferError";
}

const validateIdentifier = (name: string, value: string): void => {
  let control = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) control = true;
  }
  if (!value || control) {
    throw new CacheTransferError(`invalid cache transfer ${name}`);
  }
};

const validateEvidence = (evidence: ArchiveEvidence): void => {
  if (
    !Number.isSafeInteger(evidence.bytes) ||
    evidence.bytes < 0 ||
    !SHA256.test(evidence.digest)
  ) {
    throw new CacheTransferError("invalid cache archive evidence");
  }
};

const sameEvidence = (left: ArchiveEvidence, right: ArchiveEvidence): boolean =>
  left.bytes === right.bytes && left.digest === right.digest;

const datetime = (value: Date): string =>
  value
    .toISOString()
    .replaceAll(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

const encodedPath = (bucket: string, key: string): string =>
  `/${[bucket, ...key.split("/")].map(encodeURIComponent).join("/")}`;

export class CloudflareCacheTransfer {
  readonly #accountId: string;
  readonly #bucket: string;
  readonly #client: AwsClient;
  readonly #expiresInSeconds: number;
  readonly #log: (entry: CacheTransferLog) => void;
  readonly #now: () => Date;
  readonly #objects: CacheObjects;
  readonly #transport: CacheTransferTransport;

  constructor(options: CloudflareCacheTransferOptions) {
    validateIdentifier("account", options.accountId);
    validateIdentifier("bucket", options.bucket);
    validateIdentifier("access key", options.accessKeyId);
    validateIdentifier("secret key", options.secretAccessKey);
    if (
      !Number.isSafeInteger(options.expiresInSeconds) ||
      options.expiresInSeconds < 1 ||
      options.expiresInSeconds > MAX_CAPABILITY_SECONDS
    ) {
      throw new CacheTransferError(
        `cache transfer capability expiry must be between 1 and ${MAX_CAPABILITY_SECONDS} seconds`,
      );
    }
    this.#accountId = options.accountId;
    this.#bucket = options.bucket;
    this.#client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
      service: "s3",
      region: "auto",
      retries: 0,
    });
    this.#expiresInSeconds = options.expiresInSeconds;
    this.#transport = options.transport;
    this.#objects = options.objects;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? (() => {});
  }

  async #capability(
    method: CacheTransferCapability["method"],
    request: TransferRequest,
    evidence?: ArchiveEvidence,
  ): Promise<CacheTransferCapability> {
    validateIdentifier("run", request.runId);
    validateIdentifier("key", request.key);
    const issuedAt = this.#now();
    const pathname = encodedPath(this.#bucket, request.key);
    const url = new URL(`https://${this.#accountId}.r2.cloudflarestorage.com${pathname}`);
    url.searchParams.set("X-Amz-Expires", String(this.#expiresInSeconds));
    const headers =
      method === "PUT" && evidence
        ? {
            "content-length": String(evidence.bytes),
            "content-type": "application/octet-stream",
            "if-none-match": "*",
            "x-amz-meta-runway-run": request.runId,
            "x-amz-meta-runway-sha256": evidence.digest,
          }
        : {};
    const signed = await this.#client.sign(url, {
      method,
      headers,
      aws: { signQuery: true, allHeaders: true, datetime: datetime(issuedAt) },
    });
    const capability = {
      method,
      url: signed.url,
      headers,
      expiresAtMs: issuedAt.getTime() + this.#expiresInSeconds * 1000,
    } satisfies CacheTransferCapability;
    this.#validateCapability(capability, pathname);
    return capability;
  }

  #validateCapability(capability: CacheTransferCapability, pathname: string): void {
    const url = new URL(capability.url);
    const expires = Number(url.searchParams.get("X-Amz-Expires"));
    const signedHeaders = new Set(
      (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";").filter(Boolean),
    );
    if (
      url.protocol !== "https:" ||
      url.host !== `${this.#accountId}.r2.cloudflarestorage.com` ||
      url.pathname !== pathname ||
      expires !== this.#expiresInSeconds ||
      expires > MAX_CAPABILITY_SECONDS ||
      !url.searchParams.has("X-Amz-Signature") ||
      !signedHeaders.has("host")
    ) {
      throw new CacheTransferError("invalid cache transfer capability");
    }
    for (const name of Object.keys(capability.headers)) {
      if (!signedHeaders.has(name)) throw new CacheTransferError("unsigned cache transfer header");
    }
    if (capability.method === "PUT" && capability.headers["if-none-match"] !== "*") {
      throw new CacheTransferError("cache upload capability is not immutable");
    }
  }

  async #session<T>(work: (session: CacheTransferSession) => Promise<T>): Promise<T> {
    let session: CacheTransferSession;
    try {
      session = await this.#transport.quiesce();
    } catch {
      throw new CacheTransferError("cache transfer could not quiesce Sandbox processes");
    }
    const outcome = await work(session).then(
      (value) => ({ state: "finished" as const, value }),
      (error: unknown) => ({ state: "failed" as const, error }),
    );
    try {
      await session.close();
    } catch {
      throw new CacheTransferError("cache transfer session cleanup failed");
    }
    if (outcome.state === "failed") {
      if (outcome.error instanceof CacheTransferError) throw outcome.error;
      throw new CacheTransferError("cache archive transfer failed");
    }
    return outcome.value;
  }

  async put(
    request: TransferRequest,
  ): Promise<ArchiveEvidence & { readonly state: "stored" | "present" }> {
    const startedAt = this.#now().getTime();
    const result = await this.#session(async (session) => {
      const archive = await session.inspect(request.path);
      validateEvidence(archive);
      const capability = await this.#capability("PUT", request, archive);
      const state = await session.upload({ path: request.path, capability });
      const stored = await this.#objects.head(request.key);
      if (!stored || !sameEvidence(stored, archive)) {
        throw new CacheTransferError("uploaded cache archive failed verification");
      }
      return { state: state === "stored" ? "stored" : "present", ...archive } as const;
    });
    this.#log({
      operation: "put",
      state: result.state === "stored" ? "finished" : "present",
      durationMs: Math.max(0, this.#now().getTime() - startedAt),
      bytes: result.bytes,
    });
    return result;
  }

  async get(
    request: TransferRequest & { readonly expected: ArchiveEvidence },
  ): Promise<ArchiveEvidence> {
    validateEvidence(request.expected);
    const stored = await this.#objects.head(request.key);
    if (!stored || !sameEvidence(stored, request.expected)) {
      throw new CacheTransferError("cache archive is absent or failed verification");
    }
    const startedAt = this.#now().getTime();
    const result = await this.#session(async (session) => {
      const capability = await this.#capability("GET", request);
      const downloaded = await session.download({ path: request.path, capability });
      if (!sameEvidence(downloaded, request.expected)) {
        throw new CacheTransferError("downloaded cache archive failed verification");
      }
      return downloaded;
    });
    this.#log({
      operation: "get",
      state: "finished",
      durationMs: Math.max(0, this.#now().getTime() - startedAt),
      bytes: result.bytes,
    });
    return result;
  }
}
