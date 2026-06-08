import type { HttpArgs, HttpResult, Json } from "./types.ts";

// A plain authenticated HTTP call — the general escape hatch for any API. (Often you can just
// import that API's SDK and call it inside a step.do instead; this is the no-dependency path.)
export const runHttp = async (args: HttpArgs): Promise<HttpResult> => {
  const headers: Record<string, string> = { ...args.headers };
  let body = args.body;
  if (args.json !== undefined) {
    body = JSON.stringify(args.json);
    headers["content-type"] ??= "application/json";
  }

  const res = await fetch(args.url, {
    method: args.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body === undefined ? {} : { body }),
  });

  const text = await res.text();
  let json: Json = null;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
};
