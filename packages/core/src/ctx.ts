import type { Ctx, Primitives } from "./types.ts";

export const makeCtx = (primitives: Primitives, meta: { runId: string; params?: unknown }): Ctx => {
  let sleeps = 0;
  return {
    runId: meta.runId,
    params: meta.params,
    step: (id, fn) => primitives.step(id, () => Promise.resolve(fn({ id }))),
    sleep: (ms) => primitives.sleep(`sleep-${sleeps++}`, ms),
  };
};
