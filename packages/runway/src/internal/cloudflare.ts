import Cloudflare from "cloudflare";

type AsyncMethod<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<unknown>;

export type CloudflareApi = {
  accounts: {
    list(): Promise<unknown>;
  };
  workers: {
    routes: {
      create(params: { zone_id: string; pattern: string; script: string }): Promise<unknown>;
      list(params: { zone_id: string }): Promise<unknown>;
      get(routeId: string, params: { zone_id: string }): Promise<unknown>;
      delete(routeId: string, params: { zone_id: string }): Promise<unknown>;
    };
    scripts: {
      list(params: { account_id: string }): Promise<unknown>;
      update: AsyncMethod<Cloudflare["workers"]["scripts"]["update"]>;
      delete(scriptName: string, params: { account_id: string; force?: boolean }): Promise<unknown>;
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
      deployments: {
        list(scriptName: string, params: { account_id: string }): Promise<unknown>;
      };
      schedules: {
        update: AsyncMethod<Cloudflare["workers"]["scripts"]["schedules"]["update"]>;
        get(scriptName: string, params: { account_id: string }): Promise<unknown>;
      };
      subdomain: {
        create: AsyncMethod<Cloudflare["workers"]["scripts"]["subdomain"]["create"]>;
        get(scriptName: string, params: { account_id: string }): Promise<unknown>;
      };
      scriptAndVersionSettings: {
        get(scriptName: string, params: { account_id: string }): Promise<unknown>;
      };
    };
    subdomains: {
      get(params: { account_id: string }): Promise<unknown>;
    };
  };
  durableObjects: {
    namespaces: {
      list(params: { account_id: string }): Promise<unknown>;
    };
  };
  workflows: {
    update: AsyncMethod<Cloudflare["workflows"]["update"]>;
    list(params: { account_id: string }): Promise<unknown>;
    delete: AsyncMethod<Cloudflare["workflows"]["delete"]>;
    versions: {
      list(workflowName: string, params: { account_id: string }): Promise<unknown>;
    };
  };
  zones: {
    list(params: { account: { id: string }; per_page?: number }): Promise<unknown>;
  };
  containers: {
    applications: {
      list(params: { account_id: string }): Promise<unknown>;
      create(params: { account_id: string; body: unknown }): Promise<unknown>;
      modify(
        applicationId: string,
        params: { account_id: string; body: unknown },
      ): Promise<unknown>;
      delete(applicationId: string, params: { account_id: string }): Promise<unknown>;
    };
    rollouts: {
      create(
        applicationId: string,
        params: { account_id: string; body: unknown },
      ): Promise<unknown>;
      get(
        applicationId: string,
        rolloutId: string,
        params: { account_id: string },
      ): Promise<unknown>;
      list(applicationId: string, params: { account_id: string }): Promise<unknown>;
    };
  };
  r2: {
    buckets: {
      list(params: { account_id: string }): Promise<unknown>;
      get(bucketName: string, params: { account_id: string }): Promise<unknown>;
      create(params: { account_id: string; name: string }): Promise<unknown>;
      delete(bucketName: string, params: { account_id: string }): Promise<unknown>;
      lifecycle: {
        get(bucketName: string, params: { account_id: string }): Promise<unknown>;
      };
      cors: {
        get(bucketName: string, params: { account_id: string }): Promise<unknown>;
      };
      domains: {
        managed: {
          list(bucketName: string, params: { account_id: string }): Promise<unknown>;
        };
        custom: {
          list(bucketName: string, params: { account_id: string }): Promise<unknown>;
        };
      };
      objects: {
        upload(
          bucketName: string,
          objectKey: string,
          body: Uint8Array,
          params: { account_id: string },
          options?: { headers?: Readonly<Record<string, string>> },
        ): Promise<unknown>;
        list(bucketName: string, params: { account_id: string; prefix?: string }): Promise<unknown>;
        get(
          bucketName: string,
          objectKey: string,
          params: { account_id: string },
        ): Promise<unknown>;
        delete(
          bucketName: string,
          objectKey: string,
          params: { account_id: string },
        ): Promise<unknown>;
      };
    };
  };
};

export const cloudflare7Compatibility = (
  cf: Pick<Cloudflare, "workers" | "r2">,
): Pick<CloudflareApi, "workers" | "r2"> => {
  const workers = Object.assign(Object.create(cf.workers), {
    scripts: Object.assign(Object.create(cf.workers.scripts), {
      versions: Object.assign(Object.create(cf.workers.scripts.versions), {
        get: async (scriptName: string, versionId: string, params: { account_id: string }) =>
          await cf.workers.scripts.versions.get(versionId, {
            ...params,
            script_name: scriptName,
          }),
      }),
    }),
  }) as CloudflareApi["workers"];
  const r2 = Object.assign(Object.create(cf.r2), {
    buckets: Object.assign(Object.create(cf.r2.buckets), {
      objects: Object.assign(Object.create(cf.r2.buckets.objects), {
        upload: async (
          bucketName: string,
          objectKey: string,
          body: Uint8Array,
          params: { account_id: string },
          options?: { headers?: Readonly<Record<string, string>> },
        ) =>
          await cf.r2.buckets.objects.upload(
            objectKey,
            body,
            { ...params, bucket_name: bucketName },
            options,
          ),
        get: async (bucketName: string, objectKey: string, params: { account_id: string }) =>
          await cf.r2.buckets.objects.get(objectKey, {
            ...params,
            bucket_name: bucketName,
          }),
        delete: async (bucketName: string, objectKey: string, params: { account_id: string }) =>
          await cf.r2.buckets.objects.delete(objectKey, {
            ...params,
            bucket_name: bucketName,
          }),
      }),
    }),
  }) as CloudflareApi["r2"];
  return { workers, r2 };
};

export const defaultClient = (
  apiToken: string,
  request: typeof globalThis.fetch = globalThis.fetch,
): CloudflareApi => {
  const cf = new Cloudflare({ apiToken, timeout: 15_000 });
  const containerRequest = async (
    accountId: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> => {
    const method = init.method ?? "GET";
    const attempts = method === "GET" ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response: Response;
      try {
        response = await request(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers${path}`,
          {
            method,
            headers: {
              authorization: `Bearer ${apiToken}`,
              ...(init.body ? { "content-type": "application/json" } : {}),
            },
            ...(init.body ? { body: JSON.stringify(init.body) } : {}),
            signal: AbortSignal.timeout(15_000),
          },
        );
      } catch (error) {
        if (method === "GET" && attempt < attempts - 1) continue;
        throw new Error("Cloudflare Containers API request failed", { cause: error });
      }
      const text = await response.text();
      if (response.ok) return text ? (JSON.parse(text) as unknown) : undefined;
      if (
        method === "GET" &&
        attempt < attempts - 1 &&
        (response.status === 429 || response.status >= 500)
      ) {
        continue;
      }
      throw new Error(`Cloudflare Containers API ${response.status}: ${text}`);
    }
    throw new Error("Cloudflare Containers API request exhausted retries");
  };
  const { workers, r2 } = cloudflare7Compatibility(cf);
  return {
    accounts: cf.accounts,
    workers,
    workflows: cf.workflows,
    zones: cf.zones,
    durableObjects: cf.durableObjects,
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
        delete: async (applicationId, { account_id }) =>
          await containerRequest(account_id, `/applications/${applicationId}`, {
            method: "DELETE",
          }),
      },
      rollouts: {
        create: async (applicationId, { account_id, body }) =>
          await containerRequest(account_id, `/applications/${applicationId}/rollouts`, {
            method: "POST",
            body,
          }),
        get: async (applicationId, rolloutId, { account_id }) =>
          await containerRequest(
            account_id,
            `/applications/${applicationId}/rollouts/${rolloutId}`,
          ),
        list: async (applicationId, { account_id }) =>
          await containerRequest(account_id, `/applications/${applicationId}/rollouts`),
      },
    },
    r2,
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
  if (isAsyncIterable(response)) {
    for await (const item of response) {
      const value = collect(item);
      if (value !== undefined) values.push(value);
    }
    return values;
  }
  const result = resultOf(response);
  if (Array.isArray(result)) {
    for (const item of result) {
      const value = collect(item);
      if (value !== undefined) values.push(value);
    }
  }
  return values;
};
