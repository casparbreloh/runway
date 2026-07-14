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
): Ctx => ({
  runId: meta.runId,
  secrets: meta.secrets,
  env: meta.env,
  step: {
    do: (id, fn) => primitives.step.do(id, () => Promise.resolve(fn({ id }))),
    sleep: (id, durationMs) => primitives.step.sleep(id, durationMs),
  },
});
