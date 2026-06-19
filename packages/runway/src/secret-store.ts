import type { CloudflareApi } from "./deploy.ts";

const resultOf = (response: unknown): unknown =>
  response && typeof response === "object" && "result" in response
    ? (response as { result: unknown }).result
    : response;

const secretNamesOf = async (response: unknown): Promise<ReadonlyArray<string>> => {
  const names: string[] = [];
  const collect = (item: unknown): void => {
    if (item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string") {
      names.push((item as { name: string }).name);
    }
  };
  const result = resultOf(response);
  if (Array.isArray(result)) {
    result.forEach(collect);
    return names;
  }
  if (response && typeof response === "object" && Symbol.asyncIterator in response) {
    for await (const item of response as AsyncIterable<unknown>) collect(item);
  }
  return names;
};

const isMissingScript = (err: unknown): boolean =>
  err instanceof Error &&
  ("status" in err ? (err as { status?: unknown }).status === 404 : /not found/i.test(err.message));

export const listScriptSecrets = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
): Promise<ReadonlySet<string>> => {
  try {
    return new Set(
      await secretNamesOf(
        await cf.workers.scripts.secrets.list(scriptName, { account_id: accountId }),
      ),
    );
  } catch (err) {
    if (isMissingScript(err)) return new Set();
    throw err;
  }
};

export const setScriptSecret = async (
  cf: CloudflareApi,
  accountId: string,
  scriptName: string,
  name: string,
  value: string,
): Promise<void> => {
  await cf.workers.scripts.secrets.bulkUpdate(scriptName, {
    account_id: accountId,
    secrets: {
      [name]: { type: "secret_text", name, text: value },
    },
  });
};
