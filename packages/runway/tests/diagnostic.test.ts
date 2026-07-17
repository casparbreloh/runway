import { expect, test } from "vitest";

import { failureDiagnosticOf, parseFailureDiagnostic } from "../src/diagnostic.ts";
import { ExecError, trustedExecError } from "../src/exec-error.ts";

test("failure diagnostics contain only bounded redacted command result tails", () => {
  const secret = "diagnostic-secret";
  const command = "curl https://command.example --token diagnostic-secret";
  const error = trustedExecError("test", command, {
    exitCode: 1,
    stdout: `${"🙂".repeat(3_000)} ${secret} https://stdout.example/path`,
    stderr: `\u001b[31mfailed\u001b[0m ${secret} https://stderr.example/path`,
    durationMs: 1,
  });

  const diagnostic = failureDiagnosticOf(error, { TOKEN: secret });
  expect(diagnostic).not.toBeNull();
  expect(new TextEncoder().encode(diagnostic!.stdout).byteLength).toBeLessThanOrEqual(4 * 1024);
  expect(new TextEncoder().encode(diagnostic!.stderr).byteLength).toBeLessThanOrEqual(4 * 1024);
  expect(JSON.stringify(diagnostic)).not.toContain(secret);
  expect(JSON.stringify(diagnostic)).not.toContain(command);
  expect(JSON.stringify(diagnostic)).not.toContain("https://");
  expect(diagnostic!.stderr).toContain("failed");
});

test("failure diagnostics reject arbitrary errors and invalid transport shapes", () => {
  expect(failureDiagnosticOf(new Error("arbitrary-secret https://example.com"), {})).toBeNull();
  expect(
    failureDiagnosticOf(
      new ExecError("forged", "forged command", {
        exitCode: 1,
        stdout: "forged stdout",
        stderr: "forged stderr",
        durationMs: 1,
      }),
      {},
    ),
  ).toBeNull();
  for (const value of [
    undefined,
    {},
    { stdout: "", stderr: "" },
    { stdout: "https://example.com", stderr: "" },
    { stdout: "a".repeat(4 * 1024 + 1), stderr: "" },
    { stdout: "tail", stderr: "", extra: true },
  ]) {
    expect(() => parseFailureDiagnostic(value)).toThrow("invalid failure diagnostic");
  }
});
