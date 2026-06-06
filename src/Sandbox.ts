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
  readonly setEnvVars: (env: Record<string, string>) => Effect.Effect<void>;
}

export const Sandbox = Context.Service<SandboxService>("Sandbox");
export type Sandbox = (typeof Sandbox)["Identifier"];

export interface RecorderState {
  readonly commands: Ref.Ref<ReadonlyArray<string>>;
  readonly writes: Ref.Ref<ReadonlyArray<{ path: string; content: string }>>;
  readonly envVars: Ref.Ref<Record<string, string>>;
}

export const Recorder = Context.Service<RecorderState>("Recorder");
export type Recorder = (typeof Recorder)["Identifier"];

export const sandboxLayer = (impl: SandboxService): Layer.Layer<Sandbox> => Layer.succeed(Sandbox, impl);

export const RecordingSandbox = (
  responder?: (command: string) => Partial<ExecResult>,
): Layer.Layer<Sandbox | Recorder> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<string>>([]);
      const writes = yield* Ref.make<ReadonlyArray<{ path: string; content: string }>>([]);
      const envVars = yield* Ref.make<Record<string, string>>({});

      const sandbox: SandboxService = {
        exec: (command) =>
          Ref.update(commands, (c) => [...c, command]).pipe(
            Effect.map((): ExecResult => {
              const r = responder?.(command) ?? {};
              return { command, exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
            }),
          ),
        writeFile: (path, content) => Ref.update(writes, (w) => [...w, { path, content }]),
        setEnvVars: (env) => Ref.update(envVars, (e) => ({ ...e, ...env })),
      };

      return Context.make(Sandbox, sandbox).pipe(Context.add(Recorder, { commands, writes, envVars }));
    }),
  );
