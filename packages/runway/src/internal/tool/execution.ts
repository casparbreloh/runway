import type { ExecOptions, ExecResult, Step } from "../../step.ts";
import { toolProviders, type Tools } from "../../tools.ts";

type Operations = Pick<Step, "exec" | "cache">;

export const shell = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const withEnvironment = (
  command: string | ExecOptions,
  paths: readonly string[],
  env: Readonly<Record<string, string>>,
): ExecOptions => {
  const options = typeof command === "string" ? { command } : command;
  const exports = [
    ...(paths.length > 0 ? [`export PATH=${shell(paths.join(":"))}:"$PATH"`] : []),
    ...Object.entries(env).map(([name, value]) => `export ${name}=${shell(value)}`),
  ];
  return { ...options, command: [...exports, options.command].join("\n") };
};

export const withTools = (operations: Operations, tools: Tools | undefined): Operations => {
  const providers = toolProviders(tools);
  if (providers.length === 0) return operations;
  let preparation: Promise<void> | undefined;
  const prepare = (): Promise<void> => {
    preparation ??= (async () => {
      for (const provider of providers) {
        if (provider.cache) {
          await operations.cache(`runway:tools:${provider.id}:cache`, provider.cache);
        }
      }
      const setupPaths: string[] = [];
      const setupEnv: Record<string, string> = {};
      for (const provider of providers) {
        setupPaths.push(...(provider.paths ?? []));
        Object.assign(setupEnv, provider.env ?? {});
        await operations.exec(
          `runway:tools:${provider.id}:setup`,
          withEnvironment(provider.setup, setupPaths, setupEnv),
        );
      }
    })();
    return preparation;
  };
  const paths = providers.flatMap((provider) => provider.paths ?? []);
  const env: Record<string, string> = {};
  for (const provider of providers) {
    for (const [name, value] of Object.entries(provider.env ?? {})) {
      const existing = env[name];
      if (existing !== undefined && existing !== value) {
        throw new Error(`tool providers disagree on environment variable ${name}`);
      }
      env[name] = value;
    }
  }
  return {
    cache: operations.cache,
    exec: async (id: string, command: string | ExecOptions): Promise<ExecResult> => {
      await prepare();
      return await operations.exec(id, withEnvironment(command, paths, env));
    },
  };
};
