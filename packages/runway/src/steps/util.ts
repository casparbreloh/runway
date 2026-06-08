import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

// Re-acquire the container by id. The DO stub isn't serializable across durable step
// boundaries, so every step resolves it fresh. A generous sleepAfter keeps the filesystem
// alive across the (fast, back-to-back) steps of one run, then auto-expires.
const SLEEP_AFTER = "1h";
export const sandboxFor = (env: Env, id: string): Sandbox =>
  getSandbox(env.Sandbox, id, { sleepAfter: SLEEP_AFTER });

// Keep step results well under the 1 MiB step-output cap and scrub any URL credentials
// (e.g. https://x-access-token:TOKEN@host) from anything we surface.
const REDACT = /https:\/\/[^@\s/]+@/g;
export const tail = (s: string): string => (s.length > 4000 ? s.slice(-4000) : s);
export const redact = (s: string): string => tail(s).replace(REDACT, "https://***@");

// Allow only shell-safe tokens for the few values Runway itself interpolates into a command.
const SAFE = /^[A-Za-z0-9._/-]+$/;
export const assertSafe = (...values: ReadonlyArray<string>): void => {
  for (const v of values) {
    if (!SAFE.test(v)) throw new Error(`unsafe value for shell: ${v}`);
  }
};

export const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
