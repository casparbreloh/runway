import { runAgent } from "./agent.ts";
import { runAi } from "./ai.ts";
import type { Ctx, Primitives } from "./types.ts";

export const secretsOf = (
  names: ReadonlyArray<string>,
  source: unknown,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    names.map((name): [string, string] => {
      const value = (source as Record<string, unknown>)[name];
      if (typeof value !== "string") throw new Error(`missing secret: ${name}`);
      return [name, value];
    }),
  );

export const makeCtx = (
  primitives: Primitives,
  meta: {
    runId: string;
    secrets: Readonly<Record<string, string>>;
    env: unknown;
  },
): Ctx => {
  let sleeps = 0;
  return {
    runId: meta.runId,
    secrets: meta.secrets,
    env: meta.env,
    step: (id, fn) => primitives.step(id, () => Promise.resolve(fn({ id }))),
    ai: (id, opts) => primitives.step(id, () => runAi(opts)),
    agent: (id, opts) =>
      primitives.step(id, async () =>
        runAgent(await primitives.sandbox(`${meta.runId}-${id}`), opts),
      ),
    sandbox: (id, fn) =>
      primitives.step(id, async () => {
        return await fn(await primitives.sandbox(`${meta.runId}-${id}`));
      }),
    sleep: (ms) => primitives.sleep(`sleep-${sleeps++}`, ms),
  };
};
