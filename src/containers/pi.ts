import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

interface ExecResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Container running the Pi coding agent CLI. Exposes the SandboxService surface
 * (exec/writeFile/readFile/setEnvVars) as RPC methods. The Dockerfile installs
 * only git, gh, and the pi CLI to keep the image minimal.
 */
export class PiContainer extends Cloudflare.Container<
  PiContainer,
  {
    exec: (command: string) => Effect.Effect<ExecResult, PlatformError>;
    writeFile: (path: string, content: string) => Effect.Effect<void, PlatformError>;
    readFile: (path: string) => Effect.Effect<string, PlatformError>;
    setEnvVars: (env: Record<string, string>) => Effect.Effect<void>;
  }
>()("PiContainer", {
  main: import.meta.filename,
  runtime: "node",
  instanceType: "dev",
  dockerfile: [
    "FROM node:22-slim",
    "RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates && rm -rf /var/lib/apt/lists/*",
    "RUN npm i -g @earendil-works/pi-coding-agent",
  ].join("\n"),
}) {}

export const PiContainerLive = /* @__PURE__ */ PiContainer.make(
  Effect.gen(function* () {
    const cp = yield* ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;

    // In-instance env map persisted across exec calls so secrets/config set via
    // setEnvVars are merged into every spawned process.
    const env: Record<string, string> = {};

    return PiContainer.of({
      exec: (command) =>
        cp.spawn(ChildProcess.make(command, { shell: true, env })).pipe(
          Effect.flatMap((handle) =>
            Effect.all(
              [
                handle.exitCode,
                handle.stdout.pipe(Stream.decodeText, Stream.mkString),
                handle.stderr.pipe(Stream.decodeText, Stream.mkString),
              ],
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map(
            ([exitCode, stdout, stderr]): ExecResult => ({
              command,
              exitCode,
              stdout,
              stderr,
            }),
          ),
          Effect.scoped,
        ),
      writeFile: (path, content) => fs.writeFileString(path, content),
      readFile: (path) => fs.readFileString(path),
      setEnvVars: (vars) =>
        Effect.sync(() => {
          Object.assign(env, vars);
        }),
      fetch: Effect.succeed(HttpServerResponse.text("pi container")),
    });
  }),
);

export default PiContainerLive;
