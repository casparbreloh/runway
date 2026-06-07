import { Effect } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

import { deviceLogin } from "./device.ts";

const WORKER = process.env["RUNWAY_URL"] ?? "";
const TOKEN = process.env["RUNWAY_TOKEN"] ?? "";

const log = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${WORKER}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// `runway login` — drive the Codex device flow, push the canonical token to the
// vault under `codex` (serves both agents). Static secrets go via `secret set`.
const login = Effect.gen(function* () {
  const tokens = yield* deviceLogin((url, code) => log(`\nOpen ${url} and enter:  ${code}\n`));
  yield* Effect.promise(() => post("/secrets", { name: "codex", value: JSON.stringify(tokens) }));
  log("✓ codex subscription saved");
}).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie);

const USAGE = `runway — trigger flows and manage credentials

Usage:
  runway login                      device-code login for the codex subscription
  runway secret set <name> <value>  store a static secret (api key, webhook secret)
  runway run <flow> [json]          trigger a flow with an optional JSON body

Environment:
  RUNWAY_URL    the deployed worker url
  RUNWAY_TOKEN  the bearer token (RUNWAY_API_TOKEN)`;

const main = async (): Promise<void> => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "login") {
    await Effect.runPromise(login);
  } else if (cmd === "secret" && rest[0] === "set" && rest[1] && rest[2] !== undefined) {
    await post("/secrets", { name: rest[1], value: rest[2] });
    log(`✓ secret ${rest[1]} saved`);
  } else if (cmd === "run" && rest[0]) {
    let body: unknown = {};
    try {
      body = rest[1] ? JSON.parse(rest[1]) : {};
    } catch {
      log("invalid json body");
      return;
    }
    await post(`/run/${rest[0]}`, body);
    log(`✓ flow ${rest[0]} triggered`);
  } else {
    log(USAGE);
  }
};

void main();
