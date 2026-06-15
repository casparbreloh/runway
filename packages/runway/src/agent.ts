import type { Sandbox } from "./types.ts";

export interface AgentOptions {
  readonly args: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly files?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

interface SandboxResult {
  readonly success?: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent@0.79.1";
const WORKSPACE = "/workspace";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const commandOf = (args: ReadonlyArray<string>): string => args.map(quote).join(" ");

const workspacePath = (path: string): string => {
  const parts = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`invalid agent file path: ${path}`);
  }
  return `${WORKSPACE}/${path}`;
};

const resultOf = (result: unknown): SandboxResult =>
  result && typeof result === "object" ? (result as SandboxResult) : {};

export const runAgent = async (sandbox: Sandbox, opts: AgentOptions): Promise<string> => {
  const files = Object.entries(opts.files ?? {});
  for (const [path, content] of files) {
    await sandbox.writeFile(workspacePath(path), content);
  }

  const result = resultOf(
    await sandbox.exec(commandOf(["npx", "--yes", PI_PACKAGE, ...opts.args]), {
      cwd: WORKSPACE,
      timeout: opts.timeoutMs ?? 120_000,
      ...(opts.env ? { env: opts.env } : {}),
    }),
  );

  const success = result.success === true || result.exitCode === 0;
  if (!success) throw new Error(result.stderr || `pi exited ${result.exitCode ?? "unknown"}`);
  return (result.stdout ?? "").trim();
};
