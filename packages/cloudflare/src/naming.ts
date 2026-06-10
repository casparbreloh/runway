export const bindingOf = (id: string): string => id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

export const classOf = (id: string): string =>
  id
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
