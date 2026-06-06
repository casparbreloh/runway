import { createHmac } from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { isFreshTimestamp, linearSource, verifyLinearSignature } from "../src/sources/linear.ts";
import { inMemoryStore } from "../src/store.ts";
import { issue } from "./fixtures.ts";

const config = {
  workspace: "ws1",
  defaultAgent: "pi",
  defaultBase: "main",
  triggerState: "Runway",
} as const;

describe("linear source", () => {
  it.effect("maps an issue to a job, resolving the repo via the RepoMap (co-equal resolvers)", () =>
    Effect.gen(function* () {
      const fromMap = yield* linearSource.toJobSpec(issue({}), config);
      expect(fromMap?.repo).toEqual({ owner: "acme", name: "widgets" });
      expect(fromMap?.branch).toBe("runway/eng-123");
      expect(fromMap?.agent).toBe("pi");

      // The in-issue `repo:` line is co-equal and, being most specific, wins over the map.
      const explicit = yield* linearSource.toJobSpec(
        issue({ description: "repo: other/repo" }),
        config,
      );
      expect(explicit?.repo).toEqual({ owner: "other", name: "repo" });
    }).pipe(Effect.provide(inMemoryStore({ repoMap: { ws1: { ENG: "acme/widgets" } } }))),
  );

  it.effect("rejects a forged signature", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({ hi: 1 });
      const secret = "whsec";
      const good = createHmac("sha256", secret).update(body).digest("hex");
      const raw = new TextEncoder().encode(body).buffer as ArrayBuffer;
      expect(yield* verifyLinearSignature(raw, good, secret)).toBe(true);
      expect(yield* verifyLinearSignature(raw, good.slice(0, -1) + "0", secret)).toBe(false);
      expect(yield* verifyLinearSignature(raw, "short", secret)).toBe(false);
    }),
  );

  it("rejects a stale timestamp", () => {
    const now = 1_000_000;
    expect(isFreshTimestamp(now - 30_000, now)).toBe(true);
    expect(isFreshTimestamp(now - 120_000, now)).toBe(false);
  });
});
