import { Context, Effect, Layer, Ref } from "effect";

import { type JobResult, parseRepo, type Repo, StoreError } from "./domain.ts";

export interface CredentialRecord {
  readonly content: string;
  readonly updatedAt: string;
}

export interface WorkspaceConfig {
  readonly workspace: string;
  readonly defaultRepo?: string;
  readonly defaultAgent?: string;
  readonly defaultBase?: string;
}

export interface StoreService {
  readonly getCredential: (provider: string) => Effect.Effect<CredentialRecord | null, StoreError>;
  readonly putCredential: (
    provider: string,
    content: string,
    expectedUpdatedAt?: string,
  ) => Effect.Effect<void, StoreError>;
  readonly resolveRepo: (workspace: string, key: string) => Effect.Effect<Repo | null, StoreError>;
  readonly getWorkspaceConfig: (
    workspace: string,
  ) => Effect.Effect<WorkspaceConfig | null, StoreError>;
  readonly getJob: (id: string) => Effect.Effect<JobResult | null, StoreError>;
  readonly putJob: (result: JobResult) => Effect.Effect<void, StoreError>;
}

export const Store = Context.Service<StoreService>("Store");
export type Store = (typeof Store)["Identifier"];

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const base64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export interface Cipher {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
}

export const importKey = (base64Key: string): Effect.Effect<CryptoKey, StoreError> =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey("raw", base64ToBytes(base64Key), { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]),
    catch: (e) => new StoreError({ reason: `importKey: ${String(e)}` }),
  });

export const encrypt = (
  key: CryptoKey,
  plaintext: string,
  aad: string,
): Effect.Effect<Cipher, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: utf8(aad) },
        key,
        utf8(plaintext),
      );
      return { ciphertext: new Uint8Array(ct), iv };
    },
    catch: (e) => new StoreError({ reason: `encrypt: ${String(e)}` }),
  });

export const decrypt = (
  key: CryptoKey,
  cipher: Cipher,
  aad: string,
): Effect.Effect<string, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: cipher.iv, additionalData: utf8(aad) },
        key,
        cipher.ciphertext,
      );
      return new TextDecoder().decode(pt);
    },
    catch: (e) => new StoreError({ reason: `decrypt: ${String(e)}` }),
  });

export interface InMemorySeed {
  readonly credentials?: Record<string, string>;
  readonly repoMap?: Record<string, Record<string, string>>;
  readonly workspaces?: Record<string, WorkspaceConfig>;
}

export const inMemoryStore = (seed: InMemorySeed = {}): Layer.Layer<Store> =>
  Layer.effect(
    Store,
    Effect.gen(function* () {
      const tick = yield* Ref.make(0);
      const stamp = Ref.updateAndGet(tick, (n) => n + 1).pipe(Effect.map((n) => `v${n}`));
      const creds = yield* Ref.make<Record<string, CredentialRecord>>(
        Object.fromEntries(
          Object.entries(seed.credentials ?? {}).map(([k, content]) => [
            k,
            { content, updatedAt: "v0" },
          ]),
        ),
      );
      const jobs = yield* Ref.make<Record<string, JobResult>>({});
      const repoMap = seed.repoMap ?? {};
      const workspaces = seed.workspaces ?? {};

      const service: StoreService = {
        getCredential: (provider) => Ref.get(creds).pipe(Effect.map((c) => c[provider] ?? null)),
        putCredential: (provider, content, expectedUpdatedAt) =>
          Effect.gen(function* () {
            const current = (yield* Ref.get(creds))[provider];
            if (
              expectedUpdatedAt !== undefined &&
              current &&
              current.updatedAt !== expectedUpdatedAt
            ) {
              return yield* Effect.fail(
                new StoreError({ reason: "credential conflict (rotated concurrently)" }),
              );
            }
            const updatedAt = yield* stamp;
            yield* Ref.update(creds, (c) => ({ ...c, [provider]: { content, updatedAt } }));
          }),
        resolveRepo: (workspace, key) =>
          Effect.try({
            try: () => {
              const slug = repoMap[workspace]?.[key];
              return slug ? parseRepo(slug) : null;
            },
            catch: (e) => new StoreError({ reason: `resolveRepo: ${String(e)}` }),
          }),
        getWorkspaceConfig: (workspace) => Effect.succeed(workspaces[workspace] ?? null),
        getJob: (id) => Ref.get(jobs).pipe(Effect.map((j) => j[id] ?? null)),
        putJob: (result) => Ref.update(jobs, (j) => ({ ...j, [result.jobId]: result })),
      };
      return service;
    }),
  );
