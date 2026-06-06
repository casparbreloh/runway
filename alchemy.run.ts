import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import Api from "./src/api.ts";
import CodexContainerLive from "./src/containers/codex.ts";
import PiContainerLive from "./src/containers/pi.ts";
import { Db } from "./src/db.ts";

export default Alchemy.Stack(
  "runway",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const db = yield* Db;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      databaseId: db.databaseId,
    };
    // Provide the container .make() runtimes so the bundler emits their
    // entrypoints. The AgentDO binds both containers; the Worker binds the DO.
  }).pipe(Effect.provide(Layer.mergeAll(CodexContainerLive, PiContainerLive))),
);
