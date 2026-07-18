declare const SECRET: unique symbol;

export interface SecretRef<Name extends string = string> {
  readonly [SECRET]: Name;
}

export const secretRef = <Name extends string>(name: Name): SecretRef<Name> =>
  ({ name }) as unknown as SecretRef<Name>;

export const secretNameOf = (ref: SecretRef): string => (ref as unknown as { name: string }).name;
