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
      update: AsyncMethod<Cloudflare["workers"]["scripts"]["update"]>;
      secrets: {
        list(scriptName: string, params: { account_id: string }): Promise<unknown>;
        bulkUpdate(scriptName: string, params: unknown): Promise<unknown>;
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
};

export const defaultClient = (apiToken: string): CloudflareApi => {
  const cf = new Cloudflare({ apiToken });
  return {
    accounts: cf.accounts,
    workers: cf.workers,
    workflows: cf.workflows,
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
