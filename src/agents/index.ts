import type { AgentName } from "../domain.ts";
import type { Agent } from "./agent.ts";
import { codexAgent } from "./codex.ts";
import { piAgent } from "./pi.ts";

export type { Agent } from "./agent.ts";

export const agents: Record<AgentName, Agent> = {
  codex: codexAgent,
  pi: piAgent,
};
