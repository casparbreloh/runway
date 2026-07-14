const valuesOf = (secrets: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);

export const redactSecrets = (value: string, secrets: ReadonlyArray<string>): string =>
  valuesOf(secrets).reduce((text, secret) => text.split(secret).join("***"), value);

export const redactError = (error: unknown, secrets: ReadonlyArray<string>): Error => {
  const source = error instanceof Error ? error : new Error(String(error));
  const sanitized = new Error(redactSecrets(source.message, secrets));
  sanitized.name = source.name;
  if (source.stack) sanitized.stack = redactSecrets(source.stack, secrets);
  return sanitized;
};

export class StreamingRedactor {
  private pending = "";
  private readonly values: ReadonlyArray<string>;
  private readonly maxLength: number;

  constructor(secrets: ReadonlyArray<string>) {
    this.values = valuesOf(secrets);
    this.maxLength = this.values[0]?.length ?? 0;
  }

  push(chunk: string): string {
    this.pending += chunk;
    return this.drain(false);
  }

  flush(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    if (this.maxLength === 0) {
      const output = this.pending;
      this.pending = "";
      return output;
    }
    let output = "";
    let consumed = 0;
    const limit = final
      ? this.pending.length
      : Math.max(0, this.pending.length - this.maxLength + 1);
    while (consumed < limit) {
      const secret = this.values.find((value) => this.pending.startsWith(value, consumed));
      if (secret) {
        output += "***";
        consumed += secret.length;
      } else {
        output += this.pending[consumed];
        consumed += 1;
      }
    }
    this.pending = this.pending.slice(consumed);
    return output;
  }
}
