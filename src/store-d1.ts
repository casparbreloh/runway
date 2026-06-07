import { Effect, Layer } from "effect";

import { type JobResult, StoreError } from "./domain.ts";
import { decrypt, encrypt, Store } from "./store.ts";

const D1_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, iv BLOB NOT NULL, key_version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, agent TEXT NOT NULL, result_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
].join("\n");

export const migrate = (db: D1Database): Effect.Effect<void, StoreError> =>
  Effect.tryPromise({
    try: () => db.exec(D1_SCHEMA),
    catch: (e) => new StoreError({ reason: `migrate: ${String(e)}` }),
  }).pipe(Effect.asVoid);

const fail =
  (op: string) =>
  (e: unknown): StoreError =>
    new StoreError({ reason: `${op}: ${String(e)}` });

export const d1Store = (db: D1Database, key: CryptoKey, now: () => string): Layer.Layer<Store> =>
  Layer.succeed(Store, {
    getCredential: (provider) =>
      Effect.gen(function* () {
        const row = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare("SELECT ciphertext, iv, updated_at FROM credentials WHERE provider = ?")
              .bind(provider)
              .first<{ ciphertext: ArrayBuffer; iv: ArrayBuffer; updated_at: string }>(),
          catch: fail("getCredential"),
        });
        if (!row) return null;
        const content = yield* decrypt(
          key,
          { ciphertext: new Uint8Array(row.ciphertext), iv: new Uint8Array(row.iv) },
          provider,
        );
        return { content, updatedAt: row.updated_at };
      }),

    putCredential: (provider, content, expectedUpdatedAt) =>
      Effect.gen(function* () {
        const cipher = yield* encrypt(key, content, provider);
        const updatedAt = now();
        if (expectedUpdatedAt === undefined) {
          yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  "INSERT INTO credentials (provider, ciphertext, iv, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, updated_at = excluded.updated_at",
                )
                .bind(provider, cipher.ciphertext, cipher.iv, updatedAt)
                .run(),
            catch: fail("putCredential"),
          });
          return;
        }
        const res = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                "UPDATE credentials SET ciphertext = ?, iv = ?, updated_at = ? WHERE provider = ? AND updated_at = ?",
              )
              .bind(cipher.ciphertext, cipher.iv, updatedAt, provider, expectedUpdatedAt)
              .run(),
          catch: fail("putCredential"),
        });
        if (res.meta.changes === 0) {
          return yield* Effect.fail(
            new StoreError({ reason: "credential conflict (rotated concurrently)" }),
          );
        }
      }),

    getJob: (id) =>
      Effect.tryPromise({
        try: () =>
          db
            .prepare("SELECT result_json FROM jobs WHERE id = ?")
            .bind(id)
            .first<{ result_json: string }>(),
        catch: fail("getJob"),
      }).pipe(Effect.map((row) => (row ? (JSON.parse(row.result_json) as JobResult) : null))),

    putJob: (result) =>
      Effect.tryPromise({
        try: () =>
          db
            .prepare(
              "INSERT INTO jobs (id, status, agent, result_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, result_json = excluded.result_json, updated_at = excluded.updated_at",
            )
            .bind(result.jobId, result.status, result.agent, JSON.stringify(result), now())
            .run(),
        catch: fail("putJob"),
      }).pipe(Effect.asVoid),
  });
