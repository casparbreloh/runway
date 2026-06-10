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
    params?: unknown;
    secrets: Readonly<Record<string, string>>;
    env: unknown;
  },
): Ctx<string> => {
  let sleeps = 0;
  return {
    runId: meta.runId,
    params: meta.params,
    secrets: meta.secrets,
    env: meta.env,
    step: (id, fn) => primitives.step(id, () => Promise.resolve(fn({ id }))),
    sleep: (ms) => primitives.sleep(`sleep-${sleeps++}`, ms),
  };
};
