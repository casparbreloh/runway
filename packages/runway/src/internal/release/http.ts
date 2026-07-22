import type { PreparedRelease } from "../publish/artifacts.ts";
import {
  currentReleaseResultOf,
  releaseActivationResultOf,
  releasePreflightResultOf,
} from "./protocol.ts";
import type { ActiveRelease, ReleaseRegistry } from "./registry.ts";

const base64 = (value: Uint8Array): string => Buffer.from(value).toString("base64");

export class HttpReleaseControl {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(opts: { url: string; token: string; fetch?: typeof globalThis.fetch }) {
    this.#url = opts.url;
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? globalThis.fetch;
  }

  async current(): Promise<
    { readonly active: ActiveRelease; readonly registry: ReleaseRegistry } | undefined
  > {
    const response = await this.#fetch(this.#url, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`release endpoint failed: ${response.status}`);
    return currentReleaseResultOf(await response.json());
  }

  async activate(
    release: PreparedRelease,
    expected: ActiveRelease | null,
  ): Promise<{ readonly changed: boolean; readonly active: ActiveRelease }> {
    const identities = release.artifacts.map(({ workflowId, artifactVersion }) => ({
      workflowId,
      artifactVersion,
    }));
    const preflightResponse = await this.#fetch(this.#url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema: 1,
        registryVersion: release.registryVersion,
        artifacts: identities,
      }),
    });
    if (!preflightResponse.ok) {
      throw new Error(`release preflight failed: ${await preflightResponse.text()}`);
    }
    const preflight = releasePreflightResultOf(await preflightResponse.json());
    const missing = new Set(
      preflight.missingArtifacts.map(
        ({ workflowId, artifactVersion }) => `${workflowId}\0${artifactVersion}`,
      ),
    );
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schema: 1,
        expected,
        registryVersion: release.registryVersion,
        ...(preflight.missingRegistry
          ? { registryContents: base64(release.registryContents) }
          : {}),
        artifacts: release.artifacts.map((artifact) => ({
          workflowId: artifact.workflowId,
          artifactVersion: artifact.artifactVersion,
          ...(missing.has(`${artifact.workflowId}\0${artifact.artifactVersion}`)
            ? { contents: base64(artifact.contents) }
            : {}),
        })),
      }),
    });
    if (!response.ok) throw new Error(`release activation failed: ${await response.text()}`);
    return releaseActivationResultOf(await response.json());
  }
}
