import type { Ctx, Primitives } from "./types.ts";

export const makeCtx = (prims: Primitives, meta: { runId: string; params?: unknown }): Ctx => {
  let sleeps = 0;
  return {
    runId: meta.runId,
    params: meta.params,
    step: (id, fn) => prims.step(id, () => Promise.resolve(fn({ id }))),
    sleep: (ms) => prims.sleep(`sleep-${sleeps++}`, ms),
  };
};
