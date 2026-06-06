// The sandbox command-runner service: exec/writeFile/setEnvVars over a Cloudflare Sandbox,
// plus a recording test double that captures everything into shared Refs.
import { Context, Effect, Layer, Ref } from "effect";

export interface ExecResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxService {
  /** Non-zero exitCode is DATA, not a failure — callers decide what to do with it. */
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

/** = Layer.succeed(Sandbox, impl) — wrap a concrete SandboxService as a Layer. */
export const sandboxLayer = (impl: SandboxService): Layer.Layer<Sandbox> => Layer.succeed(Sandbox, impl);

/**
 * A recording test double. Provides both Sandbox and Recorder over shared Refs:
 * exec/writeFile/setEnvVars record their inputs, and exec's result comes from `responder`.
 */
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
            Effect.as<ExecResult>(((): ExecResult => {
              const r = responder?.(command) ?? {};
              return {
                command,
                exitCode: r.exitCode ?? 0,
                stdout: r.stdout ?? "",
                stderr: r.stderr ?? "",
              };
            })()),
          ),
        writeFile: (path, content) => Ref.update(writes, (w) => [...w, { path, content }]),
        setEnvVars: (env) => Ref.update(envVars, (e) => ({ ...e, ...env })),
      };

      const recorder: RecorderState = { commands, writes, envVars };

      return Context.make(Sandbox, sandbox).pipe(Context.add(Recorder, recorder));
    }),
  );
