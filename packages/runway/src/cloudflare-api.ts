import Cloudflare from "cloudflare";

type AsyncMethod<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<unknown>;

export type CloudflareApi = {
  accounts: {
    list(): Promise<unknown>;
  };
  workers: {
    scripts: {
      list(params: { account_id: string }): Promise<unknown>;
      update: AsyncMethod<Cloudflare["workers"]["scripts"]["update"]>;
      secrets: {
        list(scriptName: string, params: { account_id: string }): Promise<unknown>;
        bulkUpdate(scriptName: string, params: unknown): Promise<unknown>;
      };
      versions: {
        list(
          scriptName: string,
          params: { account_id: string; per_page?: number },
        ): Promise<unknown>;
        get(
          scriptName: string,
          versionId: string,
          params: { account_id: string },
        ): Promise<unknown>;
      };
      schedules: {
        update: AsyncMethod<Cloudflare["workers"]["scripts"]["schedules"]["update"]>;
      };
      subdomain: {
        create: AsyncMethod<Cloudflare["workers"]["scripts"]["subdomain"]["create"]>;
      };
    };
    subdomains: {
      get(params: { account_id: string }): Promise<unknown>;
    };
  };
  workflows: {
    update: AsyncMethod<Cloudflare["workflows"]["update"]>;
    list(params: { account_id: string }): Promise<unknown>;
    delete: AsyncMethod<Cloudflare["workflows"]["delete"]>;
  };
  containers: {
    applications: {
      list(params: { account_id: string }): Promise<unknown>;
      create(params: { account_id: string; body: unknown }): Promise<unknown>;
      modify(
        applicationId: string,
        params: { account_id: string; body: unknown },
      ): Promise<unknown>;
    };
  };
};

export const defaultClient = (apiToken: string): CloudflareApi => {
  const cf = new Cloudflare({ apiToken });
  const containerRequest = async (
    accountId: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers${path}`,
      {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${apiToken}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      },
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`Cloudflare Containers API ${response.status}: ${text}`);
    return text ? (JSON.parse(text) as unknown) : undefined;
  };
  return {
    accounts: cf.accounts,
    workers: cf.workers,
    workflows: cf.workflows,
    containers: {
      applications: {
        list: async ({ account_id }) => await containerRequest(account_id, "/applications"),
        create: async ({ account_id, body }) =>
          await containerRequest(account_id, "/applications", { method: "POST", body }),
        modify: async (applicationId, { account_id, body }) =>
          await containerRequest(account_id, `/applications/${applicationId}`, {
            method: "PATCH",
            body,
          }),
      },
    },
  };
};

export const resultOf = (response: unknown): unknown =>
  response && typeof response === "object" && "result" in response
    ? (response as { result: unknown }).result
    : response;

const isAsyncIterable = (response: unknown): response is AsyncIterable<unknown> =>
  !!response && typeof response === "object" && Symbol.asyncIterator in response;

export const collectResultItems = async <T>(
  response: unknown,
  collect: (item: unknown) => T | undefined,
): Promise<ReadonlyArray<T>> => {
  const values: T[] = [];
  const result = resultOf(response);
  if (Array.isArray(result)) {
    for (const item of result) {
      const value = collect(item);
      if (value !== undefined) values.push(value);
    }
    return values;
  }
  if (isAsyncIterable(response)) {
    for await (const item of response) {
      const value = collect(item);
      if (value !== undefined) values.push(value);
    }
  }
  return values;
};
