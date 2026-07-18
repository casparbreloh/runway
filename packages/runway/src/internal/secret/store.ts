import { collectResultItems } from "../cloudflare.ts";
import type { CloudflareApi } from "../cloudflare.ts";

const secretNamesOf = async (response: unknown): Promise<ReadonlyArray<string>> => {
  return collectResultItems(response, (item) =>
    item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
      ? (item as { name: string }).name
      : undefined,
  );
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
