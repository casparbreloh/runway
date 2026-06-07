import { Data, Duration, Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import type { SubTokens } from "../auth/codex.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const BASE = "https://auth.openai.com";
const REDIRECT = `${BASE}/deviceauth/callback`;

export class DeviceError extends Data.TaggedError("DeviceError")<{ readonly reason: string }> {}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const postJson = (
  url: string,
  body: unknown,
): Effect.Effect<Record<string, unknown>, DeviceError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.bodyJson(body)(HttpClientRequest.post(url));
    const response = yield* client.execute(request);
    return obj(yield* response.json);
  }).pipe(Effect.catch((e) => Effect.fail(new DeviceError({ reason: String(e) }))));

const accountIdFromJwt = (jwt: string): string | undefined => {
  const part = jwt.split(".")[1];
  if (!part) return undefined;
  try {
    const claims = obj(JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))));
    return str(obj(claims["https://api.openai.com/auth"])["chatgpt_account_id"]) || undefined;
  } catch {
    return undefined;
  }
};

const pollLoop = (
  deviceAuthId: string,
  userCode: string,
  attempts: number,
): Effect.Effect<{ code: string; verifier: string }, DeviceError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (attempts <= 0) return yield* Effect.fail(new DeviceError({ reason: "login timed out" }));
    const j = yield* postJson(`${BASE}/api/accounts/deviceauth/token`, {
      device_auth_id: deviceAuthId,
      user_code: userCode,
    });
    const code = str(j["authorization_code"]);
    if (code) return { code, verifier: str(j["code_verifier"]) };
    yield* Effect.sleep(Duration.seconds(3));
    return yield* pollLoop(deviceAuthId, userCode, attempts - 1);
  });

// Hand-rolled OpenAI Codex device-code login — proprietary flow, no library covers
// it. `show` is called with the verification URL + code for the user to enter.
export const deviceLogin = (
  show: (url: string, code: string) => void,
): Effect.Effect<SubTokens, DeviceError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const start = yield* postJson(`${BASE}/api/accounts/deviceauth/usercode`, {
      client_id: CLIENT_ID,
    });
    const deviceAuthId = str(start["device_auth_id"]);
    const userCode = str(start["user_code"]);
    if (!deviceAuthId || !userCode)
      return yield* Effect.fail(new DeviceError({ reason: "could not start device auth" }));

    yield* Effect.sync(() => show(`${BASE}/codex/device`, userCode));

    const authorized = yield* pollLoop(deviceAuthId, userCode, 200);

    const tok = yield* postJson(`${BASE}/oauth/token`, {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: authorized.code,
      code_verifier: authorized.verifier,
      redirect_uri: REDIRECT,
    });
    const access = str(tok["access_token"]);
    const refresh = str(tok["refresh_token"]);
    if (!access || !refresh)
      return yield* Effect.fail(new DeviceError({ reason: "token exchange failed" }));
    const idToken = str(tok["id_token"]);
    const expiresIn = typeof tok["expires_in"] === "number" ? tok["expires_in"] : 3600;
    return {
      access,
      refresh,
      expires: Date.now() + expiresIn * 1000,
      accountId: accountIdFromJwt(idToken || access),
      idToken: idToken || undefined,
    };
  });
