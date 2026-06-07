import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { deviceLogin } from "../src/cli/device.ts";

// a real-shaped id_token JWT carrying the ChatGPT account id
const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = `h.${b64url({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-123" } })}.s`;

const oauthMock = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => {
    const respond = (data: unknown) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(JSON.stringify(data), { status: 200 })),
      );
    if (request.url.includes("usercode"))
      return respond({ device_auth_id: "d1", user_code: "WXYZ-1234", interval: 1 });
    if (request.url.includes("deviceauth/token"))
      return respond({ authorization_code: "ac", code_verifier: "cv" });
    if (request.url.includes("oauth/token"))
      return respond({
        access_token: "ACCESS",
        refresh_token: "REFRESH",
        expires_in: 3600,
        id_token: idToken,
      });
    return respond({});
  }),
);

describe("device login", () => {
  it.effect(
    "runs the device-code flow and returns canonical tokens (account id from the JWT)",
    () =>
      Effect.gen(function* () {
        let shown = "";
        const tokens = yield* deviceLogin((url, code) => {
          shown = `${url} ${code}`;
        }).pipe(Effect.orDie);

        expect(shown).toContain("WXYZ-1234");
        expect(tokens.access).toBe("ACCESS");
        expect(tokens.refresh).toBe("REFRESH");
        expect(tokens.accountId).toBe("acc-123");
        expect(tokens.expires).toBeGreaterThan(Date.now());
      }).pipe(Effect.provide(oauthMock)),
  );
});
