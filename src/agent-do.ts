import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import type { AgentName } from "./domain.ts";
import { CodexContainer } from "./containers/codex.ts";
import { PiContainer } from "./containers/pi.ts";

/**
 * A single Durable Object namespace that binds both agent containers. Per job
 * it starts only the chosen agent's container and forwards the SandboxService
 * surface (exec/writeFile/readFile/setEnvVars) to it. The agent is selected by
 * a key passed as the first argument of each method, keeping the DO a thin
 * adapter between the Worker and the containers.
 */
export default class AgentDO extends Cloudflare.DurableObjectNamespace<AgentDO>()(
  "AgentDO",
  Effect.gen(function* () {
    const codex = yield* Cloudflare.Container.bind(CodexContainer);
    const pi = yield* Cloudflare.Container.bind(PiContainer);

    return Effect.gen(function* () {
      const codexContainer = yield* Cloudflare.start(codex, { enableInternet: true });
      const piContainer = yield* Cloudflare.start(pi, { enableInternet: true });
      const select = (agent: AgentName) => (agent === "pi" ? piContainer : codexContainer);

      return {
        exec: (agent: AgentName, command: string) => select(agent).exec(command),
        writeFile: (agent: AgentName, path: string, content: string) =>
          select(agent).writeFile(path, content),
        readFile: (agent: AgentName, path: string) => select(agent).readFile(path),
        setEnvVars: (agent: AgentName, env: Record<string, string>) =>
          select(agent).setEnvVars(env),
      };
    });
  }),
) {}
