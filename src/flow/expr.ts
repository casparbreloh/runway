const resolvePath = (ctx: Record<string, unknown>, path: string): unknown => {
  let cur: unknown = ctx;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
};

const TEMPLATE = /\{\{\s*([\w.]+)\s*\}\}/g;
const SINGLE = /^\{\{\s*([\w.]+)\s*\}\}$/;

const stringify = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value as string | number | boolean);
};

export const interpolate = (template: string, ctx: Record<string, unknown>): string =>
  template.replace(TEMPLATE, (_match, path: string) => stringify(resolvePath(ctx, path)));

export const evalValue = (template: string, ctx: Record<string, unknown>): unknown => {
  const path = SINGLE.exec(template.trim())?.[1];
  return path !== undefined ? resolvePath(ctx, path) : interpolate(template, ctx);
};
