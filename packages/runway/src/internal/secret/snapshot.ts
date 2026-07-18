interface SecretSnapshotOptions {
  readonly scope: string;
  readonly secretNames: ReadonlyArray<string>;
  key(binding: string): Promise<{ readonly identity: string; readonly key: CryptoKey }>;
}

const encode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decode = (value: string): Uint8Array => {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("invalid secret snapshot");
  }
};

const envelopeOf = (snapshot: string): { readonly key: string; readonly value: string } => {
  let envelope: unknown;
  try {
    envelope = JSON.parse(snapshot);
  } catch {
    throw new Error("invalid secret snapshot");
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    Object.keys(envelope).sort().join(",") !== "key,value"
  ) {
    throw new Error("invalid secret snapshot");
  }
  const { key, value } = envelope as Record<string, unknown>;
  if (typeof key !== "string" || typeof value !== "string") {
    throw new Error("invalid secret snapshot");
  }
  return { key, value };
};

const secretsOf = (
  plaintext: ArrayBuffer,
  secretNames: ReadonlyArray<string>,
): Readonly<Record<string, string>> => {
  const secrets = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new Error("invalid secret snapshot");
  }
  const record = secrets as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...secretNames].sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index] || typeof record[name] !== "string")
  ) {
    throw new Error("invalid secret snapshot");
  }
  return record as Readonly<Record<string, string>>;
};

const aad = (options: SecretSnapshotOptions, runId: string, key: string): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify([options.scope, runId, key, [...options.secretNames].sort()]),
  );

export const createSecretSnapshots = (options: SecretSnapshotOptions) => ({
  async capture(
    runId: string,
    keyBinding: string,
    secrets: Readonly<Record<string, string>>,
  ): Promise<string> {
    const resolved = await options.key(keyBinding);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(options, runId, resolved.identity) },
        resolved.key,
        new TextEncoder().encode(JSON.stringify(secrets)),
      ),
    );
    const value = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    value.set(iv);
    value.set(ciphertext, iv.byteLength);
    return JSON.stringify({ key: resolved.identity, value: encode(value) });
  },

  async restore(runId: string, snapshot: string): Promise<Readonly<Record<string, string>>> {
    try {
      const { key, value } = envelopeOf(snapshot);
      const resolved = await options.key(key);
      if (resolved.identity !== key) throw new Error("invalid secret snapshot");
      const bytes = decode(value);
      if (bytes.byteLength <= 28) throw new Error("invalid secret snapshot");
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(options, runId, key) },
        resolved.key,
        bytes.slice(12),
      );
      return secretsOf(plaintext, options.secretNames);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid secret snapshot key") throw error;
      throw new Error("invalid secret snapshot");
    }
  },
});
