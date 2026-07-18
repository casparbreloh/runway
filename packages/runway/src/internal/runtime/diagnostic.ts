import { isTrustedExecError } from "../../step.ts";
import { redactSecrets } from "../secret/redaction.ts";

const MAX_STREAM_BYTES = 4 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ansi = new RegExp(
  String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))`,
  "gu",
);
const url = /https?:\/\/[^\s"'<>]+/giu;
const unsafeControl = new RegExp(String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]`, "gu");

export interface FailureDiagnostic {
  readonly stdout: string;
  readonly stderr: string;
}

const tail = (value: string): string => {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= MAX_STREAM_BYTES) return decoder.decode(bytes);
  let start = bytes.byteLength - MAX_STREAM_BYTES;
  while ((bytes[start]! & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
};

const sanitize = (value: string, secrets: readonly string[]): string =>
  tail(
    redactSecrets(value, secrets)
      .replace(ansi, "")
      .replace(url, "[redacted-url]")
      .replace(unsafeControl, ""),
  );

export const failureDiagnosticOf = (
  error: unknown,
  secrets: Readonly<Record<string, string>>,
): FailureDiagnostic | null => {
  if (!isTrustedExecError(error)) return null;
  const values = Object.values(secrets);
  const diagnostic = {
    stdout: sanitize(error.result.stdout, values),
    stderr: sanitize(error.result.stderr, values),
  };
  return diagnostic.stdout || diagnostic.stderr ? diagnostic : null;
};

export const parseFailureDiagnostic = (value: unknown): FailureDiagnostic | null => {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "stderr,stdout"
  ) {
    throw new Error("invalid failure diagnostic");
  }
  const { stdout, stderr } = value as Record<string, unknown>;
  if (
    typeof stdout !== "string" ||
    typeof stderr !== "string" ||
    (!stdout && !stderr) ||
    sanitize(stdout, []) !== stdout ||
    sanitize(stderr, []) !== stderr
  ) {
    throw new Error("invalid failure diagnostic");
  }
  return { stdout, stderr };
};

export const sameFailureDiagnostic = (
  left: FailureDiagnostic | null,
  right: FailureDiagnostic | null,
): boolean => left?.stdout === right?.stdout && left?.stderr === right?.stderr;
