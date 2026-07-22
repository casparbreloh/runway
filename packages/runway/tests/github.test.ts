import { createHmac, createPublicKey, verify } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  GITHUB_WEBHOOK_MAX_BYTES,
  matchGitHubDelivery,
  normalizeGitHubDelivery,
  parseGitHubDelivery,
} from "../src/internal/github/delivery.ts";
import {
  createGitHubProvider,
  GitHubRepositoryUnavailableError,
} from "../src/internal/github/provider.ts";

const repository = { id: 17, name: "runway", fullName: "acme/runway" } as const;
const forkRepository = {
  id: 23,
  name: "runway-fork",
  fullName: "contributor/runway-fork",
} as const;
const deliveryId = "123e4567-e89b-42d3-a456-426614174000";
const webhookSecret = "webhook-secret-fixture";
const appId = "12345";
const now = Date.parse("2026-07-15T12:00:00.000Z");
const privateKeyPkcs1 = `-----BEGIN RSA PRIVATE KEY-----
MIICXQIBAAKBgQC4lgFwdMaUC1HqFOsUhkh2lPZ0mLhJWLKASdchsf8PObD6BNGK
SBMpTiF6iC10Z7BUEXXLWKI0kRVf6ZcEMVcy8Nbk4ur04X5HVqbTIL8nxqQ/0lOn
LRh3WX1Ian/vqZXZEKYn8vyM5zbSFqMR8h7IJCPeaRi1uKsiEWw433kxIwIDAQAB
AoGASR6a+Vo446JMU6bvrJS5FchSjMOGlP9+zlTx1JY3DGf1FEVeYCHG/WDG4Ewb
fXYpolO8Ts4QizRBvFnDCdUlzgpVPMGt9AHZUBRoN0i7f1E/ZssPcOKpcNcUu6rd
xvwn5ufIVFmEuMyKZYQqbKsq4OK3NF9QRnvzobuO0BCd3GECQQDrfV/gK/TZYQL4
uD1uq5yvEbCqcZrOAi15VFPkYMoZDPGOJiUzaDdZSMWGHYijaUNY1AMyx/oijjgq
O8FvcsExAkEAyKmmE0ahcozarhk5/USpA0B57jQ63+hAsyYjLhQpwZMKcLpyBVC5
c/valW7WjWE8mKpMzh5ENSEgnp4D+LfikwJBANR5nxQpFRc+DOxVcDh25zye/YQM
VN0j4dvjVn5tRmwr3Zegm1gy5B3PJ0nHRA4NYBK52Njszqh3If4ZRINGS0ECQACL
hWnz/ShEfauPYfrwHs1ldW9SMP6+sL5L0jij0WE3NwYLW5fsGjTYcEWLoYWMyA9a
Fw9QQbsrNd14bGZWiYUCQQCyJn503Cl2cFWEbS7ZEQpbrRvIuR1h+MiaDVdEEbC5
aqu4cRg4b0ioKCKjYOQSsYvoIp9tpbbW2m+5afdjhtZW
-----END RSA PRIVATE KEY-----`;
const privateKeyPkcs8 = `-----BEGIN PRIVATE KEY-----
MIICdwIBADANBgkqhkiG9w0BAQEFAASCAmEwggJdAgEAAoGBALiWAXB0xpQLUeoU
6xSGSHaU9nSYuElYsoBJ1yGx/w85sPoE0YpIEylOIXqILXRnsFQRdctYojSRFV/p
lwQxVzLw1uTi6vThfkdWptMgvyfGpD/SU6ctGHdZfUhqf++pldkQpify/IznNtIW
oxHyHsgkI95pGLW4qyIRbDjfeTEjAgMBAAECgYBJHpr5WjjjokxTpu+slLkVyFKM
w4aU/37OVPHUljcMZ/UURV5gIcb9YMbgTBt9dimiU7xOzhCLNEG8WcMJ1SXOClU8
wa30AdlQFGg3SLt/UT9myw9w4qlw1xS7qt3G/Cfm58hUWYS4zIplhCpsqyrg4rc0
X1BGe/Ohu47QEJ3cYQJBAOt9X+Ar9NlhAvi4PW6rnK8RsKpxms4CLXlUU+RgyhkM
8Y4mJTNoN1lIxYYdiKNpQ1jUAzLH+iKOOCo7wW9ywTECQQDIqaYTRqFyjNquGTn9
RKkDQHnuNDrf6ECzJiMuFCnBkwpwunIFULlz+9qVbtaNYTyYqkzOHkQ1ISCengP4
t+KTAkEA1HmfFCkVFz4M7FVwOHbnPJ79hAxU3SPh2+NWfm1GbCvdl6CbWDLkHc8n
ScdEDg1gErnY2OzOqHch/hlEg0ZLQQJAAIuFafP9KER9q49h+vAezWV1b1Iw/r6w
vkvSOKPRYTc3Bgtbl+waNNhwRYuhhYzID1oXD1BBuys13XhsZlaJhQJBALImfnTc
KXZwVYRtLtkRClutG8i5HWH4yJoNV0QRsLlqq7hxGDhvSKgoIqNg5BKxi+gin22l
ttbab7lp92OG1lY=
-----END PRIVATE KEY-----`;

const pushPayload = {
  ref: "refs/heads/main",
  after: "0123456789abcdef0123456789abcdef01234567",
  deleted: false,
  repository: { id: 17, name: "runway", full_name: "acme/runway", default_branch: "main" },
  installation: { id: 29 },
};

const signatureOf = (body: string) =>
  `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;

const requestOf = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://runway.test/runway/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "push",
      ...headers,
    },
    body,
  });

const config = {
  repository,
  installationId: 29,
  webhookSecret,
  events: [{ type: "push", branches: ["main"] }] as const,
};

const pullRequestPayload = {
  action: "opened",
  number: 41,
  repository: { id: 17, name: "runway", full_name: "acme/runway", default_branch: "main" },
  installation: { id: 29 },
  pull_request: {
    base: { repo: { id: 17, name: "runway", full_name: "acme/runway" } },
    head: {
      ref: "feature/ship-it",
      sha: "89abcdef0123456789abcdef0123456789abcdef",
      repo: { id: 23, name: "runway-fork", full_name: "contributor/runway-fork" },
    },
  },
};

const pullRequestConfig = {
  repository,
  installationId: 29,
  webhookSecret,
  events: [{ type: "pull_request", actions: ["opened", "reopened", "synchronize"] }] as const,
};

const signedRequestOf = (event: string, payload: unknown, body = JSON.stringify(payload)) =>
  requestOf(body, {
    "x-github-event": event,
    "x-hub-signature-256": signatureOf(body),
  });

describe("GitHub delivery admission", () => {
  test("rejects an unsigned delivery before attempting to parse malformed JSON", async () => {
    await expect(parseGitHubDelivery(requestOf("not json"), config)).rejects.toThrow(
      "invalid GitHub webhook signature",
    );
  });

  test("accepts a signed push at the exact configured branch and maps its exact commit", async () => {
    const body = JSON.stringify(pushPayload);

    await expect(
      parseGitHubDelivery(
        requestOf(body, { "x-hub-signature-256": signatureOf(body).toUpperCase() }),
        config,
      ),
    ).resolves.toEqual({
      status: "accepted",
      deliveryId,
      installationId: 29,
      checkRepository: repository,
      checkoutRepository: repository,
      defaultRef: "refs/heads/main",
      event: {
        type: "push",
        repository,
        ref: "refs/heads/main",
        sha: "0123456789abcdef0123456789abcdef01234567",
      },
      concurrency: { type: "push", repositoryId: 17, ref: "refs/heads/main" },
    });
  });

  test("normalizes one request body once before matching many workflow routes", async () => {
    const body = JSON.stringify(pushPayload);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        "x-github-delivery": deliveryId,
        "x-github-event": "push",
        "x-hub-signature-256": signatureOf(body),
      },
      body: stream,
      duplex: "half",
    };
    const request = new Request("https://runway.test/runway/github", init);

    const normalized = await normalizeGitHubDelivery(request, config);
    const matches = Array.from({ length: 64 }, () =>
      matchGitHubDelivery(normalized, [{ type: "push", branches: ["main"] }]),
    );

    expect(pulls).toBe(1);
    expect(matches).toHaveLength(64);
    expect(matches.every(({ status }) => status === "accepted")).toBe(true);
  });

  test("verifies the signature over the exact raw bytes", async () => {
    const signed = JSON.stringify(pushPayload);
    const delivered = JSON.stringify(pushPayload, undefined, 2);

    await expect(
      parseGitHubDelivery(
        requestOf(delivered, { "x-hub-signature-256": signatureOf(signed) }),
        config,
      ),
    ).rejects.toThrow("invalid GitHub webhook signature");
  });

  test("accepts an exactly maximum-sized signed body without Content-Length", async () => {
    const emptyPaddingBody = JSON.stringify({ ...pushPayload, padding: "" });
    const body = JSON.stringify({
      ...pushPayload,
      padding: "x".repeat(GITHUB_WEBHOOK_MAX_BYTES - emptyPaddingBody.length),
    });
    expect(new TextEncoder().encode(body)).toHaveLength(GITHUB_WEBHOOK_MAX_BYTES);

    await expect(
      parseGitHubDelivery(requestOf(body, { "x-hub-signature-256": signatureOf(body) }), config),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  test("rejects an oversized declared Content-Length before signature verification", async () => {
    const body = JSON.stringify(pushPayload);
    await expect(
      parseGitHubDelivery(
        requestOf(body, { "content-length": String(GITHUB_WEBHOOK_MAX_BYTES + 1) }),
        config,
      ),
    ).rejects.toThrow("GitHub webhook body exceeds size limit");
  });

  test.each([
    ["missing", {}],
    ["lying", { "content-length": "1" }],
  ])("stream-enforces the body limit with %s Content-Length", async (_label, headers) => {
    const body = "x".repeat(GITHUB_WEBHOOK_MAX_BYTES + 1);
    await expect(parseGitHubDelivery(requestOf(body, headers), config)).rejects.toThrow(
      "GitHub webhook body exceeds size limit",
    );
  });

  test.each([
    ["sha1=0123456789abcdef0123456789abcdef01234567", "wrong algorithm"],
    ["sha256=0123", "truncated digest"],
    [`sha256=${"g".repeat(64)}`, "non-hex digest"],
  ])("rejects a %s signature", async (signature) => {
    const body = JSON.stringify(pushPayload);
    await expect(
      parseGitHubDelivery(requestOf(body, { "x-hub-signature-256": signature }), config),
    ).rejects.toThrow("invalid GitHub webhook signature");
  });

  test.each([
    ["x-github-delivery", "not-a-uuid", "invalid GitHub delivery id"],
    ["x-github-delivery", deliveryId.toUpperCase(), "invalid GitHub delivery id"],
    ["x-github-event", "", "missing GitHub event header"],
  ])("requires a valid %s header", async (header, value, message) => {
    const body = JSON.stringify(pushPayload);
    await expect(
      parseGitHubDelivery(
        requestOf(body, {
          [header]: value,
          "x-hub-signature-256": signatureOf(body),
        }),
        config,
      ),
    ).rejects.toThrow(message);
  });

  test("rejects malformed JSON only after its signature is valid", async () => {
    const body = "not json";
    await expect(
      parseGitHubDelivery(requestOf(body, { "x-hub-signature-256": signatureOf(body) }), config),
    ).rejects.toThrow("invalid GitHub webhook JSON");
  });

  test.each([
    ["issues", { action: "opened" }, config],
    ["push", { ...pushPayload, deleted: true }, config],
    ["push", { ...pushPayload, after: "0".repeat(40) }, config],
    ["push", { ...pushPayload, ref: "refs/heads/release" }, config],
    ["push", { ...pushPayload, installation: { id: 30 } }, config],
    [
      "push",
      {
        ...pushPayload,
        repository: {
          id: 18,
          name: "runway",
          full_name: "other/runway",
          default_branch: "main",
        },
      },
      config,
    ],
  ])("skips a valid filtered %s delivery", async (event, payload, selectedConfig) => {
    await expect(
      parseGitHubDelivery(signedRequestOf(event, payload), selectedConfig),
    ).resolves.toEqual({ status: "skipped", deliveryId });
  });

  test.each([
    [{ ...pushPayload, installation: { id: 0 } }, "installation"],
    [{ ...pushPayload, after: "ABCDEF0123456789abcdef0123456789abcdef01" }, "SHA"],
    [{ ...pushPayload, ref: "refs/heads/bad..ref" }, "ref"],
  ])("rejects a malformed accepted push payload (%s)", async (payload) => {
    await expect(parseGitHubDelivery(signedRequestOf("push", payload), config)).rejects.toThrow(
      "invalid GitHub push payload",
    );
  });

  test.each(["opened", "reopened", "synchronize"] as const)(
    "accepts and normalizes a %s pull request from its exact head repository",
    async (action) => {
      const payload = { ...pullRequestPayload, action };
      await expect(
        parseGitHubDelivery(signedRequestOf("pull_request", payload), pullRequestConfig),
      ).resolves.toEqual({
        status: "accepted",
        deliveryId,
        installationId: 29,
        checkRepository: repository,
        checkoutRepository: {
          id: 23,
          name: "runway-fork",
          fullName: "contributor/runway-fork",
        },
        defaultRef: "refs/heads/main",
        event: {
          type: "pull_request",
          action,
          repository,
          number: 41,
          ref: "feature/ship-it",
          sha: "89abcdef0123456789abcdef0123456789abcdef",
        },
        concurrency: { type: "pull_request", repositoryId: 17, number: 41 },
      });
    },
  );

  test.each([
    ["an action outside the configured filter", { ...pullRequestPayload, action: "closed" }],
    [
      "a different top-level repository",
      {
        ...pullRequestPayload,
        repository: {
          id: 99,
          name: "runway",
          full_name: "other/runway",
          default_branch: "main",
        },
      },
    ],
    [
      "a different pull request base repository",
      {
        ...pullRequestPayload,
        pull_request: {
          ...pullRequestPayload.pull_request,
          base: { repo: { id: 99, name: "runway", full_name: "other/runway" } },
        },
      },
    ],
  ])("skips %s", async (_label, payload) => {
    await expect(
      parseGitHubDelivery(signedRequestOf("pull_request", payload), pullRequestConfig),
    ).resolves.toEqual({ status: "skipped", deliveryId });
  });

  test.each([
    ["missing PR number", { ...pullRequestPayload, number: 0 }],
    [
      "invalid head repository",
      {
        ...pullRequestPayload,
        pull_request: {
          ...pullRequestPayload.pull_request,
          head: {
            ...pullRequestPayload.pull_request.head,
            repo: { id: 23, name: "runway-fork", full_name: "wrong/name" },
          },
        },
      },
    ],
    [
      "uppercase head SHA",
      {
        ...pullRequestPayload,
        pull_request: {
          ...pullRequestPayload.pull_request,
          head: { ...pullRequestPayload.pull_request.head, sha: "A".repeat(40) },
        },
      },
    ],
  ])("rejects a malformed accepted pull request: %s", async (_label, payload) => {
    await expect(
      parseGitHubDelivery(signedRequestOf("pull_request", payload), pullRequestConfig),
    ).rejects.toThrow(/invalid GitHub pull request/);
  });
});

const decodeJwtPart = (value: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;

const fetchInputUrl = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : input;

describe("GitHub App installation authentication", () => {
  test("resolves a repository name to its stable installation and numeric repository identity", async () => {
    const requests: Request[] = [];
    const provider = createGitHubProvider({
      appId,
      privateKey: privateKeyPkcs1,
      now: () => now,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return request.url.endsWith("/installation")
          ? Response.json({ id: 29 })
          : Response.json({
              token: "resolution-token",
              expires_at: "2026-07-15T12:30:00.000Z",
              repositories: [{ id: 17, name: "runway", full_name: "acme/runway" }],
            });
      },
    });

    await expect(provider.resolveRepository("Acme/Runway")).resolves.toEqual({
      installationId: 29,
      repository,
    });
    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.github.com/repos/Acme/Runway/installation",
      "https://api.github.com/app/installations/29/access_tokens",
    ]);
    await expect(requests[1]!.clone().json()).resolves.toEqual({
      repositories: ["Runway"],
      permissions: { contents: "read" },
    });
  });

  test.each([
    [[{ id: 0 }], "invalid GitHub repository installation response"],
    [
      [
        { id: 29 },
        {
          token: "resolution-token",
          expires_at: "2026-07-15T12:30:00.000Z",
          repositories: [{ id: 17, name: "wrong", full_name: "acme/wrong" }],
        },
      ],
      "invalid GitHub installation token response",
    ],
  ])(
    "fails closed on an invalid publication-time repository resolution response",
    async (responses, message) => {
      let calls = 0;
      const provider = createGitHubProvider({
        appId,
        privateKey: privateKeyPkcs1,
        now: () => now,
        fetch: async () => {
          const response = responses[calls];
          calls += 1;
          return Response.json(response);
        },
      });
      await expect(provider.resolveRepository("acme/runway")).rejects.toThrow(message);
      expect(calls).toBe(responses.length);
    },
  );

  test.each([
    ["PKCS#1", privateKeyPkcs1, "checkout", { contents: "read" }],
    ["PKCS#8", privateKeyPkcs8, "checks", { checks: "write" }],
  ] as const)(
    "signs a verifiable RS256 App JWT from %s and requests a repository-scoped %s token",
    async (_format, privateKey, purpose, permissions) => {
      const capturedRequests: Request[] = [];
      const provider = createGitHubProvider({
        appId,
        privateKey,
        now: () => now,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          capturedRequests.push(request);
          if (request.url.endsWith("/repos/contributor/runway-fork/installation")) {
            return Response.json({ id: 29 });
          }
          return Response.json({
            token: "fixture-installation-token",
            expires_at: "2026-07-15T12:30:00.000Z",
            repositories: [{ id: 23 }],
          });
        },
      });

      await expect(
        provider.createInstallationToken({
          installationId: 29,
          repository: forkRepository,
          purpose,
        }),
      ).resolves.toEqual({
        token: "fixture-installation-token",
        expiresAt: "2026-07-15T12:30:00.000Z",
      });

      const [installationRequest, tokenRequest] = capturedRequests;
      expect(installationRequest?.url).toBe(
        "https://api.github.com/repos/contributor/runway-fork/installation",
      );
      expect(installationRequest?.method).toBe("GET");
      expect(tokenRequest?.url).toBe("https://api.github.com/app/installations/29/access_tokens");
      expect(tokenRequest?.method).toBe("POST");
      expect(tokenRequest?.headers.get("accept")).toBe("application/vnd.github+json");
      expect(tokenRequest?.headers.get("user-agent")).toBe("Runway");
      expect(tokenRequest?.headers.get("x-github-api-version")).toBe("2022-11-28");
      await expect(tokenRequest?.clone().json()).resolves.toEqual({
        repository_ids: [23],
        permissions,
      });

      const jwt = tokenRequest?.headers.get("authorization")?.slice("Bearer ".length);
      expect(installationRequest?.headers.get("authorization")).toBe(`Bearer ${jwt}`);
      expect(jwt).toBeDefined();
      const [encodedHeader, encodedPayload, encodedSignature] = jwt!.split(".");
      expect(decodeJwtPart(encodedHeader!)).toEqual({ alg: "RS256", typ: "JWT" });
      expect(decodeJwtPart(encodedPayload!)).toEqual({
        iat: Math.floor(now / 1000) - 60,
        exp: Math.floor(now / 1000) + 600,
        iss: appId,
      });
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${encodedHeader}.${encodedPayload}`),
          createPublicKey(privateKey),
          Buffer.from(encodedSignature!, "base64url"),
        ),
      ).toBe(true);
    },
  );

  test.each([
    ["empty token", { token: "", expires_at: "2026-07-15T12:30:00.000Z" }],
    [
      "missing repository grant list",
      { token: "returned-secret", expires_at: "2026-07-15T12:30:00.000Z" },
    ],
    ["expired token", { token: "returned-secret", expires_at: "2026-07-15T12:00:00.000Z" }],
    ["overlong token", { token: "returned-secret", expires_at: "2026-07-15T13:00:00.001Z" }],
    [
      "wrong repository grant",
      {
        token: "returned-secret",
        expires_at: "2026-07-15T12:30:00.000Z",
        repositories: [{ id: 24 }],
      },
    ],
    [
      "overbroad repository grant",
      {
        token: "returned-secret",
        expires_at: "2026-07-15T12:30:00.000Z",
        repositories: [{ id: 23 }, { id: 24 }],
      },
    ],
  ])("rejects an invalid %s response without exposing it", async (_label, response) => {
    const provider = createGitHubProvider({
      appId,
      privateKey: privateKeyPkcs1,
      now: () => now,
      fetch: async (input) =>
        fetchInputUrl(input).endsWith("/installation")
          ? Response.json({ id: 29 })
          : Response.json(response),
    });

    const result = provider.createInstallationToken({
      installationId: 29,
      repository: forkRepository,
      purpose: "checkout",
    });
    await expect(result).rejects.toThrow("invalid GitHub installation token response");
    await expect(result).rejects.not.toThrow(/returned-secret|MIICXQ/);
  });

  test.each([
    [async () => new Response("fixture-installation-token private-key-fragment", { status: 500 })],
    [async () => Promise.reject(new Error("fixture-installation-token MIICXQ"))],
  ])("sanitizes installation-token provider failures", async (fetchImpl) => {
    const provider = createGitHubProvider({
      appId,
      privateKey: privateKeyPkcs1,
      now: () => now,
      fetch: async (input) =>
        fetchInputUrl(input).endsWith("/installation") ? Response.json({ id: 29 }) : fetchImpl(),
    });

    const result = provider.createInstallationToken({
      installationId: 29,
      repository: forkRepository,
      purpose: "checks",
    });
    await expect(result).rejects.toThrow(/GitHub installation token request failed/);
    await expect(result).rejects.not.toThrow(/fixture-installation-token|MIICXQ/);
  });

  test("classifies only a repository-installation 404 as unavailable without leaking its body", async () => {
    const provider = createGitHubProvider({
      appId,
      privateKey: privateKeyPkcs1,
      now: () => now,
      fetch: async () =>
        new Response("fixture-installation-token MIICXQ repository denied", { status: 404 }),
    });

    const error = await provider
      .createInstallationToken({
        installationId: 29,
        repository: forkRepository,
        purpose: "checkout",
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(GitHubRepositoryUnavailableError);
    expect(error).toMatchObject({ installationId: 29, repositoryId: 23 });
    expect(String(error)).not.toMatch(/fixture-installation-token|MIICXQ|repository denied/);
  });

  test("keeps transient provider failures distinct from repository unavailability", async () => {
    const provider = createGitHubProvider({
      appId,
      privateKey: privateKeyPkcs1,
      now: () => now,
      fetch: async () => new Response("fixture-installation-token MIICXQ", { status: 503 }),
    });

    const error = await provider
      .createInstallationToken({
        installationId: 29,
        repository: forkRepository,
        purpose: "checkout",
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GitHubRepositoryUnavailableError);
    expect(String(error)).toBe("Error: GitHub installation token request failed (503)");
  });

  test("keeps a scoped-token 422 generic after a successful installation preflight", async () => {
    const provider = createGitHubProvider({
      appId,
      privateKey: privateKeyPkcs1,
      now: () => now,
      fetch: async (input) =>
        fetchInputUrl(input).endsWith("/installation")
          ? Response.json({ id: 29 })
          : new Response("fixture-installation-token MIICXQ validation failed", { status: 422 }),
    });

    const error = await provider
      .createInstallationToken({
        installationId: 29,
        repository: forkRepository,
        purpose: "checkout",
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GitHubRepositoryUnavailableError);
    expect(String(error)).toBe("Error: GitHub installation token request failed (422)");
    expect(String(error)).not.toMatch(/fixture-installation-token|MIICXQ|validation failed/);
  });
});

const checkSha = "fedcba9876543210fedcba9876543210fedcba98";
const checksToken = "checks-installation-token-fixture";

const checkRunResponse = (
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: 991,
  name: "Check",
  head_sha: checkSha,
  external_id: "run-123",
  status: "queued",
  conclusion: null,
  ...overrides,
});

const checkProviderWith = (fetchImpl: typeof fetch) =>
  createGitHubProvider({
    appId,
    privateKey: privateKeyPkcs1,
    now: () => now,
    fetch: fetchImpl,
  });

describe("GitHub Checks", () => {
  test("creates a queued Check for the exact SHA with the run id as external id", async () => {
    let capturedRequest: Request | undefined;
    const provider = checkProviderWith(async (input, init) => {
      capturedRequest = new Request(input, init);
      return Response.json(checkRunResponse());
    });

    await expect(
      provider.createQueuedCheck({
        token: checksToken,
        repository,
        name: "Check",
        headSha: checkSha,
        runId: "run-123",
      }),
    ).resolves.toEqual({
      id: 991,
      name: "Check",
      headSha: checkSha,
      externalId: "run-123",
      status: "queued",
      conclusion: null,
    });

    expect(capturedRequest?.url).toBe("https://api.github.com/repos/acme/runway/check-runs");
    expect(capturedRequest?.method).toBe("POST");
    expect(capturedRequest?.headers.get("authorization")).toBe(`Bearer ${checksToken}`);
    expect(capturedRequest?.headers.get("accept")).toBe("application/vnd.github+json");
    expect(capturedRequest?.headers.get("user-agent")).toBe("Runway");
    expect(capturedRequest?.headers.get("x-github-api-version")).toBe("2022-11-28");
    await expect(capturedRequest?.clone().json()).resolves.toEqual({
      name: "Check",
      head_sha: checkSha,
      external_id: "run-123",
      status: "queued",
    });
  });

  test("lists all same-name Checks at the exact SHA and reconciles only the exact external id", async () => {
    let capturedRequest: Request | undefined;
    const provider = checkProviderWith(async (input, init) => {
      capturedRequest = new Request(input, init);
      return Response.json({
        total_count: 2,
        check_runs: [checkRunResponse({ id: 990, external_id: "another-run" }), checkRunResponse()],
      });
    });

    await expect(
      provider.reconcileCheck({
        token: checksToken,
        repository,
        name: "Check",
        headSha: checkSha,
        runId: "run-123",
      }),
    ).resolves.toEqual({
      id: 991,
      name: "Check",
      headSha: checkSha,
      externalId: "run-123",
      status: "queued",
      conclusion: null,
    });

    expect(capturedRequest?.method).toBe("GET");
    expect(capturedRequest?.url).toBe(
      `https://api.github.com/repos/acme/runway/commits/${checkSha}/check-runs?check_name=Check&filter=all&per_page=100&page=1`,
    );
  });

  test("follows Check pages until it reconciles an exact external id on page two", async () => {
    const requestedPages: string[] = [];
    const provider = checkProviderWith(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedPages.push(url.searchParams.get("page") ?? "");
      return Response.json(
        url.searchParams.get("page") === "1"
          ? {
              total_count: 2,
              check_runs: [checkRunResponse({ id: 990, external_id: "another-run" })],
            }
          : { total_count: 2, check_runs: [checkRunResponse()] },
      );
    });

    await expect(
      provider.reconcileCheck({
        token: checksToken,
        repository,
        name: "Check",
        headSha: checkSha,
        runId: "run-123",
      }),
    ).resolves.toMatchObject({ id: 991, externalId: "run-123" });
    expect(requestedPages).toEqual(["1", "2"]);
  });

  test("rejects non-progressing Check pagination instead of treating it as no match", async () => {
    let requests = 0;
    const provider = checkProviderWith(async () => {
      requests += 1;
      return Response.json({ total_count: 1, check_runs: [] });
    });

    await expect(
      provider.reconcileCheck({
        token: checksToken,
        repository,
        name: "Check",
        headSha: checkSha,
        runId: "run-123",
      }),
    ).rejects.toThrow("invalid GitHub Check response");
    expect(requests).toBe(1);
  });

  test("rejects duplicate Check ids within one reconciliation page", async () => {
    const provider = checkProviderWith(async () =>
      Response.json({
        total_count: 2,
        check_runs: [
          checkRunResponse({ external_id: "another-run" }),
          checkRunResponse({ external_id: "still-another-run" }),
        ],
      }),
    );

    await expect(
      provider.reconcileCheck({
        token: checksToken,
        repository,
        name: "Check",
        headSha: checkSha,
        runId: "run-123",
      }),
    ).rejects.toThrow("invalid GitHub Check response");
  });

  test("returns no reconciliation match when all external ids differ", async () => {
    const provider = checkProviderWith(async () =>
      Response.json({
        total_count: 1,
        check_runs: [checkRunResponse({ external_id: "another-run" })],
      }),
    );

    await expect(
      provider.reconcileCheck({
        token: checksToken,
        repository,
        name: "Check",
        headSha: checkSha,
        runId: "run-123",
      }),
    ).resolves.toBeUndefined();
  });

  test("marks a Check in progress", async () => {
    let capturedRequest: Request | undefined;
    const provider = checkProviderWith(async (input, init) => {
      capturedRequest = new Request(input, init);
      return Response.json(checkRunResponse({ status: "in_progress" }));
    });

    await expect(
      provider.markCheckInProgress({ token: checksToken, repository, checkRunId: 991 }),
    ).resolves.toMatchObject({ id: 991, status: "in_progress" });
    expect(capturedRequest?.method).toBe("PATCH");
    expect(capturedRequest?.url).toBe("https://api.github.com/repos/acme/runway/check-runs/991");
    await expect(capturedRequest?.clone().json()).resolves.toEqual({ status: "in_progress" });
  });

  test.each(["success", "failure", "cancelled"] as const)(
    "completes a Check as %s",
    async (conclusion) => {
      let capturedRequest: Request | undefined;
      const provider = checkProviderWith(async (input, init) => {
        capturedRequest = new Request(input, init);
        return Response.json(checkRunResponse({ status: "completed", conclusion }));
      });

      await expect(
        provider.completeCheck({
          token: checksToken,
          repository,
          checkRunId: 991,
          conclusion,
        }),
      ).resolves.toMatchObject({ id: 991, status: "completed", conclusion });
      await expect(capturedRequest?.clone().json()).resolves.toEqual({
        status: "completed",
        conclusion,
      });
    },
  );

  test("completes a failed Check with the exact bounded diagnostic output", async () => {
    let capturedRequest: Request | undefined;
    const output = { title: "Command failed", summary: "stdout\ntail\n\nstderr\nfailed" };
    const provider = checkProviderWith(async (input, init) => {
      capturedRequest = new Request(input, init);
      return Response.json(
        checkRunResponse({ status: "completed", conclusion: "failure", output }),
      );
    });

    await expect(
      provider.completeCheck({
        token: checksToken,
        repository,
        checkRunId: 991,
        conclusion: "failure",
        output,
      }),
    ).resolves.toMatchObject({ id: 991, status: "completed", conclusion: "failure" });
    await expect(capturedRequest?.clone().json()).resolves.toEqual({
      status: "completed",
      conclusion: "failure",
      output,
    });
  });

  test("rejects invalid or mismatched Check diagnostic output", async () => {
    const provider = checkProviderWith(async () =>
      Response.json(
        checkRunResponse({
          status: "completed",
          conclusion: "failure",
          output: { title: "Command failed", summary: "different" },
        }),
      ),
    );
    await expect(
      provider.completeCheck({
        token: checksToken,
        repository,
        checkRunId: 991,
        conclusion: "failure",
        output: { title: "Command failed", summary: "expected" },
      }),
    ).rejects.toThrow("invalid GitHub Check response");
    await expect(
      provider.completeCheck({
        token: checksToken,
        repository,
        checkRunId: 991,
        conclusion: "success",
        output: { title: "Command failed", summary: "forged" },
      }),
    ).rejects.toThrow("invalid GitHub Check request");
  });

  test.each([
    [async () => new Response(`denied ${checksToken}`, { status: 403 })],
    [async () => Response.json({ id: 991, token: checksToken })],
    [async () => Promise.reject(new Error(checksToken))],
  ])("rejects and sanitizes invalid Check provider responses", async (fetchImpl) => {
    const provider = checkProviderWith(fetchImpl);
    const result = provider.createQueuedCheck({
      token: checksToken,
      repository,
      name: "Check",
      headSha: checkSha,
      runId: "run-123",
    });
    await expect(result).rejects.toThrow(
      /GitHub Check request failed|invalid GitHub Check response/,
    );
    await expect(result).rejects.not.toThrow(checksToken);
  });
});
