import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { withSubscription } from "../src/auth/subscription.ts";
import { Recorder, RecordingSandbox } from "../src/sandbox.ts";
import { inMemoryStore, Store } from "../src/store.ts";

const refreshingHttp = (hits: string[]): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      hits.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              access_token: "NEW_ACCESS",
              refresh_token: "NEW_REFRESH",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        ),
      );
    }),
  );

describe("subscription auth lifecycle", () => {
  it.effect(
    "an expired sub is refreshed, the rotated token is written back, and the new access token reaches the sandbox",
    () => {
      const hits: string[] = [];
      return Effect.gen(function* () {
        yield* withSubscription("codex", undefined, Effect.void).pipe(Effect.orDie);

        const writes = yield* Ref.get((yield* Recorder).writes);
        const stored = yield* (yield* Store).getCredential("codex");

        // the refresh endpoint was actually hit (token was expired)
        expect(hits.some((u) => u.includes("oauth/token"))).toBe(true);
        // codex's auth.json was rendered with the NEW access token
        expect(writes.find((w) => w.path === "/work/.codex/auth.json")?.content).toContain(
          "NEW_ACCESS",
        );
        // the vault now holds the ROTATED refresh token
        expect(stored?.content).toContain("NEW_REFRESH");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RecordingSandbox(),
            inMemoryStore({
              credentials: {
                codex: JSON.stringify({
                  access: "OLD",
                  refresh: "OLD_REFRESH",
                  expires: 0,
                  accountId: "acc",
                }),
              },
            }),
            refreshingHttp(hits),
          ),
        ),
      );
    },
  );
});
