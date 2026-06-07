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

// A value that is exactly `{{ path }}` yields the typed value (array/object/number);
// anything else is string-interpolated.
export const evalValue = (template: string, ctx: Record<string, unknown>): unknown => {
  const path = SINGLE.exec(template.trim())?.[1];
  return path !== undefined ? resolvePath(ctx, path) : interpolate(template, ctx);
};

// Recursively interpolate strings inside an arbitrary JSON value (for http bodies).
export const interpolateValue = (value: unknown, ctx: Record<string, unknown>): unknown => {
  if (typeof value === "string") return evalValue(value, ctx);
  if (Array.isArray(value)) return value.map((v) => interpolateValue(v, ctx));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateValue(v, ctx)]));
  }
  return value;
};

const operand = (token: string, ctx: Record<string, unknown>): unknown => {
  const t = token.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))
    return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  return resolvePath(ctx, t);
};

const clause = (c: string, ctx: Record<string, unknown>): boolean => {
  const m = /^(.+?)(==|!=)(.+)$/.exec(c);
  if (!m) return Boolean(operand(c, ctx));
  const left = operand(m[1] ?? "", ctx);
  const right = operand(m[3] ?? "", ctx);
  return m[2] === "==" ? left === right : left !== right;
};

// Boolean `when`/trigger filters: `a.b == 'x' && c != 'y' || d`. Optional `{{ }}` wrapper.
export const evalBool = (expr: string, ctx: Record<string, unknown>): boolean => {
  const raw = expr.trim().replace(/^\{\{/, "").replace(/\}\}$/, "").trim();
  return raw.split("||").some((or) => or.split("&&").every((and) => clause(and, ctx)));
};
