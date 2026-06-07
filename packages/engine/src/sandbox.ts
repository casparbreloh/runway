import { Context, Effect, Layer, Ref } from "effect";

export interface ExecResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxService {
  readonly exec: (command: string) => Effect.Effect<ExecResult>;
  readonly writeFile: (path: string, content: string) => Effect.Effect<void>;
  readonly readFile: (path: string) => Effect.Effect<string>;
  readonly setEnvVars: (env: Record<string, string>) => Effect.Effect<void>;
}

export const Sandbox = Context.Service<SandboxService>("Sandbox");
export type Sandbox = (typeof Sandbox)["Identifier"];

export interface SandboxLogState {
  readonly commands: Ref.Ref<ReadonlyArray<string>>;
  readonly writes: Ref.Ref<ReadonlyArray<{ path: string; content: string }>>;
  readonly envVars: Ref.Ref<Record<string, string>>;
}

export const SandboxLog = Context.Service<SandboxLogState>("SandboxLog");
export type SandboxLog = (typeof SandboxLog)["Identifier"];

export const sandboxLayer = (impl: SandboxService): Layer.Layer<Sandbox> =>
  Layer.succeed(Sandbox, impl);

export interface RecordingOptions {
  readonly exec?: (command: string) => Partial<ExecResult>;
  readonly read?: (path: string) => string | undefined;
}

export const RecordingSandbox = (
  options: RecordingOptions = {},
): Layer.Layer<Sandbox | SandboxLog> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      const writes = yield* Ref.make<ReadonlyArray<{ path: string; content: string }>>([]);
      const envVars = yield* Ref.make<Record<string, string>>({});

      const sandbox: SandboxService = {
        exec: (command) =>
          Ref.update(commands, (c) => [...c, command]).pipe(
            Effect.map((): ExecResult => {
              const r = options.exec?.(command) ?? {};
              return {
                command,
                exitCode: r.exitCode ?? 0,
                stdout: r.stdout ?? "",
                stderr: r.stderr ?? "",
              };
            }),
          ),
        writeFile: (path, content) => Ref.update(writes, (w) => [...w, { path, content }]),
        readFile: (path) =>
          Ref.get(writes).pipe(
            Effect.map(
              (w) => options.read?.(path) ?? w.findLast((f) => f.path === path)?.content ?? "",
            ),
          ),
        setEnvVars: (env) => Ref.update(envVars, (e) => ({ ...e, ...env })),
      };

      return Context.make(Sandbox, sandbox).pipe(
        Context.add(SandboxLog, { commands, writes, envVars }),
      );
    }),
  );
