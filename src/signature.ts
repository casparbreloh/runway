import { Effect } from "effect";

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const toBase64 = (buf: ArrayBuffer): string => {
  let binary = "";
  for (const byte of new Uint8Array(buf)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export interface SignConfig {
  readonly header: string;
  readonly alg?: "sha256" | undefined;
  readonly encoding?: "hex" | "base64" | undefined;
}

// Generic HMAC webhook verification, parameterized by a flow's `trigger.sign`.
// Covers the common family (Linear hex, GitHub `sha256=` hex, Slack hex, base64).
export const verifySignature = (
  raw: ArrayBuffer,
  signature: string,
  secret: string,
  config: SignConfig,
): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    if (!secret || !signature) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, raw);
    const computed = (config.encoding ?? "hex") === "base64" ? toBase64(mac) : toHex(mac);
    const provided = signature.replace(/^sha256=/, "");
    return constantTimeEqual(computed, provided);
  });
