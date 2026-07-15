import type { Ctx, Primitives } from "./types.ts";

const publicStepId = (id: string): string => {
  if (id.startsWith("runway:"))
    throw new Error(`step id ${JSON.stringify(id)} is reserved by Runway`);
  return id;
};

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
    do: (id, fn) => primitives.step.do(publicStepId(id), () => Promise.resolve(fn({ id }))),
    exec: (id, command) => primitives.step.exec(publicStepId(id), command),
    sleep: (id, durationMs) => primitives.step.sleep(publicStepId(id), durationMs),
  },
});
