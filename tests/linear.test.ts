import { createHmac } from "node:crypto";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  eventToJobSpec,
  isFreshTimestamp,
  type LinearConfig,
  verifyLinearSignature,
} from "../src/Linear.ts";
import type { LinearWebhook } from "../src/domain.ts";

const bodyToBuffer = (body: string): ArrayBuffer => new TextEncoder().encode(body).buffer as ArrayBuffer;

const expectedSig = (body: string, secret: string): string =>
  createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");

describe("verifyLinearSignature", () => {
  const body = JSON.stringify({ action: "create", type: "Issue", hello: "world" });
  const secret = "shhh-secret";

  it("returns true for a valid signature", async () => {
    const ok = await Effect.runPromise(verifyLinearSignature(bodyToBuffer(body), expectedSig(body, secret), secret));
    expect(ok).toBe(true);
  });

  it("returns false for a wrong signature of the same length", async () => {
    const good = expectedSig(body, secret);
    const wrong = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
    const ok = await Effect.runPromise(verifyLinearSignature(bodyToBuffer(body), wrong, secret));
    expect(ok).toBe(false);
  });

  it("returns false on a length mismatch", async () => {
    const ok = await Effect.runPromise(verifyLinearSignature(bodyToBuffer(body), "deadbeef", secret));
    expect(ok).toBe(false);
  });
});

describe("isFreshTimestamp", () => {
  it("is true within tolerance", () => {
    expect(isFreshTimestamp(1_000_000, 1_030_000)).toBe(true);
    expect(isFreshTimestamp(1_000_000, 970_000)).toBe(true);
  });

  it("is false outside tolerance", () => {
    expect(isFreshTimestamp(1_000_000, 1_070_000)).toBe(false);
    expect(isFreshTimestamp(1_000_000, 1_005_000, 1_000)).toBe(false);
  });
});

describe("eventToJobSpec", () => {
  const config: LinearConfig = {
    defaultExecutor: "pi",
    defaultBase: "main",
    triggerState: "In Progress",
    triggerComment: "/runway",
    defaultRepo: "fallback/repo",
  };

  it("maps an issue in the trigger state with a repo: line to a JobSpec", async () => {
    const payload: LinearWebhook = {
      action: "update",
      type: "Issue",
      webhookTimestamp: 1,
      data: {
        id: "abc",
        identifier: "ENG-42",
        title: "Add a feature",
        description: "Do the thing.\nrepo: o/n\nmore detail",
        state: { name: "In Progress" },
      },
    };
    const spec = await Effect.runPromise(eventToJobSpec(payload, config));
    expect(spec).not.toBeNull();
    expect(spec?.repo).toEqual({ owner: "o", name: "n" });
    expect(spec?.branch).toBe("runway/eng-42");
    expect(spec?.id).toBe("linear-eng-42");
    expect(spec?.executor).toBe("pi");
    expect(spec?.base).toBe("main");
    expect(spec?.title).toBe("Add a feature");
    expect(spec?.source).toEqual({ type: "linear", ref: "ENG-42" });
    expect(spec?.plan).toContain("Add a feature");
  });

  it("returns null when the issue is not in the trigger state", async () => {
    const payload: LinearWebhook = {
      action: "update",
      type: "Issue",
      webhookTimestamp: 1,
      data: {
        id: "abc",
        identifier: "ENG-42",
        title: "Add a feature",
        description: "repo: o/n",
        state: { name: "Backlog" },
      },
    };
    const spec = await Effect.runPromise(eventToJobSpec(payload, config));
    expect(spec).toBeNull();
  });

  it("picks codex-cloud executor from a /runway codex comment", async () => {
    const payload: LinearWebhook = {
      action: "create",
      type: "Comment",
      webhookTimestamp: 1,
      data: {
        id: "c1",
        body: "/runway codex\nPlease ship it.",
        issue: { identifier: "ENG-7", title: "Ship", description: "repo: o/n" },
      },
    };
    const spec = await Effect.runPromise(eventToJobSpec(payload, config));
    expect(spec).not.toBeNull();
    expect(spec?.executor).toBe("codex-cloud");
    expect(spec?.repo).toEqual({ owner: "o", name: "n" });
    expect(spec?.branch).toBe("runway/eng-7");
    expect(spec?.plan).toBe("Please ship it.");
  });
});
