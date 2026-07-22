import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const vitest = fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json")));
const child = spawn(process.execPath, [vitest, "run", ...process.argv.slice(2)], {
  detached: process.platform !== "win32",
  stdio: ["inherit", "pipe", "pipe"],
});

interface CapturedChunk {
  readonly stream: NodeJS.WriteStream;
  readonly value: Buffer;
}

const captured: CapturedChunk[] = [];
const stdoutChunks: Buffer[] = [];

child.stdout.on("data", (value: Buffer) => {
  captured.push({ stream: process.stdout, value });
  stdoutChunks.push(value);
});
child.stderr.on("data", (value: Buffer) => {
  captured.push({ stream: process.stderr, value });
});

const signalHandlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => ({
  signal,
  handle: (): void => {
    if (process.platform === "win32" || child.pid === undefined) {
      child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  },
}));
for (const { signal, handle } of signalHandlers) process.on(signal, handle);

const write = (stream: NodeJS.WriteStream, value: string | Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    stream.write(value, (error) => (error ? reject(error) : resolve()));
  });

const successSummary = (output: string): string | undefined => {
  const lines = output.split(/(?<=\n)/u);
  const start = lines.findLastIndex((line) =>
    /^\s*Test Files\s+\d+ passed\b/u.test(stripVTControlCharacters(line)),
  );
  if (start < 0) return undefined;

  const summary = lines.slice(start).join("");
  const plain = stripVTControlCharacters(summary);
  if (
    !/^\s*Test Files\s+\d+ passed\b/mu.test(plain) ||
    !/^\s*Tests\s+\d+ passed\b/mu.test(plain) ||
    !/^\s*Start at\s+/mu.test(plain) ||
    !/^\s*Duration\s+/mu.test(plain)
  ) {
    return undefined;
  }
  return summary;
};

const result = await new Promise<
  | { readonly code: number; readonly signal: null }
  | { readonly code: null; readonly signal: NodeJS.Signals }
>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => {
    if (code !== null) resolve({ code, signal: null });
    else if (signal !== null) resolve({ code, signal });
    else reject(new Error("Vitest exited without a status"));
  });
}).finally(() => {
  for (const { signal, handle } of signalHandlers) process.off(signal, handle);
});

if (result.code === 0) {
  const output = Buffer.concat(stdoutChunks).toString();
  await write(process.stdout, successSummary(output) ?? output);
} else {
  for (const chunk of captured) await write(chunk.stream, chunk.value);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.code;
}
