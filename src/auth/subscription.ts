import { Effect } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { type AgentName, AuthError } from "../domain.ts";
import { Sandbox } from "../sandbox.ts";
import { Store } from "../store.ts";

// Both agents run on the same Codex subscription, so the canonical tokens are
// stored ONCE under this key and rendered into each CLI's native auth file.
const SUB_KEY = "codex";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

export interface SubTokens {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number; // ms epoch
  readonly accountId?: string | undefined;
  readonly idToken?: string | undefined;
}

interface SubConfig {
  readonly env: string;
  readonly dir: string;
  readonly path: string;
  readonly format: "codex" | "pi";
}

// Adding an agent that shares the sub is a row here, not code.
export const subs: Record<AgentName, SubConfig> = {
  codex: {
    env: "CODEX_HOME",
    dir: "/work/.codex",
    path: "/work/.codex/auth.json",
    format: "codex",
  },
  pi: {
    env: "PI_CODING_AGENT_DIR",
    dir: "/work/.pi-agent",
    path: "/work/.pi-agent/auth.json",
    format: "pi",
  },
};

const nowMs = (): number => Date.now();

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

const jwtExp = (jwt: string): number => {
  const part = jwt.split(".")[1];
  if (!part) return 0;
  try {
    const claims = obj(JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))));
    return typeof claims["exp"] === "number" ? claims["exp"] * 1000 : 0;
  } catch {
    return 0;
  }
};

// canonical -> the file each CLI reads (codex nested, pi flat).
const render = (format: "codex" | "pi", t: SubTokens): string =>
  format === "codex"
    ? JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: t.idToken ?? "",
          access_token: t.access,
          refresh_token: t.refresh,
          account_id: t.accountId ?? "",
        },
        last_refresh: new Date(nowMs()).toISOString(),
      })
    : JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: t.access,
          refresh: t.refresh,
          expires: t.expires,
          accountId: t.accountId ?? "",
        },
      });

const parseCanonical = (content: string): SubTokens | null => {
  try {
    const d = obj(JSON.parse(content));
    return {
      access: str(d["access"]),
      refresh: str(d["refresh"]),
      expires: typeof d["expires"] === "number" ? d["expires"] : 0,
      accountId: str(d["accountId"]) || undefined,
      idToken: str(d["idToken"]) || undefined,
    };
  } catch {
    return null;
  }
};

// the CLI may rotate in-sandbox on a long job; parse its file back to canonical.
const parseAgent = (format: "codex" | "pi", content: string): SubTokens | null => {
  try {
    const d = obj(JSON.parse(content));
    if (format === "codex") {
      const t = obj(d["tokens"]);
      return {
        access: str(t["access_token"]),
        refresh: str(t["refresh_token"]),
        expires: jwtExp(str(t["access_token"])),
        accountId: str(t["account_id"]) || undefined,
        idToken: str(t["id_token"]) || undefined,
      };
    }
    const o = obj(d["openai-codex"]);
    return {
      access: str(o["access"]),
      refresh: str(o["refresh"]),
      expires: typeof o["expires"] === "number" ? o["expires"] : 0,
      accountId: str(o["accountId"]) || undefined,
    };
  } catch {
    return null;
  }
};

const refresh = (tokens: SubTokens): Effect.Effect<SubTokens, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.bodyJson({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: tokens.refresh,
    })(HttpClientRequest.post(TOKEN_URL));
    const response = yield* client.execute(request);
    const j = obj(yield* response.json);
    return {
      access: str(j["access_token"]) || tokens.access,
      refresh: str(j["refresh_token"]) || tokens.refresh,
      expires: nowMs() + (typeof j["expires_in"] === "number" ? j["expires_in"] : 3600) * 1000,
      accountId: tokens.accountId,
      idToken: str(j["id_token"]) || tokens.idToken,
    };
  }).pipe(Effect.catch(() => Effect.succeed(tokens)));

const writeBack = (tokens: SubTokens): Effect.Effect<void, never, Store> =>
  Effect.gen(function* () {
    const store = yield* Store;
    const current = yield* store.getCredential(SUB_KEY).pipe(Effect.orElseSucceed(() => null));
    yield* store
      .putCredential(SUB_KEY, JSON.stringify(tokens), current?.updatedAt)
      .pipe(Effect.orElseSucceed(() => undefined));
  });

// Subscription auth (OAuth): refresh-if-expired (rotating the refresh token), render
// the canonical credential into the sandbox, run `body`, then capture any in-sandbox
// rotation. `apiKey` is the static-secret fallback. Static secrets live in ./secrets.ts.
export const withSubscription = <A, E, R>(
  agentName: AgentName,
  apiKey: string | undefined,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AuthError, R | Sandbox | Store | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const store = yield* Store;
    const sub = subs[agentName];

    const stored = yield* store.getCredential(SUB_KEY).pipe(Effect.orElseSucceed(() => null));
    const canonical = stored ? parseCanonical(stored.content) : null;
    if (!canonical) {
      if (apiKey !== undefined && apiKey !== "") {
        yield* sandbox.setEnvVars({ OPENAI_API_KEY: apiKey });
        return yield* body;
      }
      return yield* Effect.fail(
        new AuthError({ reason: `no subscription or api key for agent "${agentName}"` }),
      );
    }

    let tokens = canonical;
    if (tokens.expires < nowMs()) {
      tokens = yield* refresh(tokens);
      yield* writeBack(tokens);
    }

    yield* sandbox.setEnvVars({ [sub.env]: sub.dir });
    yield* sandbox.writeFile(sub.path, render(sub.format, tokens));

    const out = yield* body;

    const after = parseAgent(
      sub.format,
      yield* sandbox.readFile(sub.path).pipe(Effect.orElseSucceed(() => "")),
    );
    if (after && after.refresh && after.refresh !== tokens.refresh) yield* writeBack(after);
    return out;
  });
