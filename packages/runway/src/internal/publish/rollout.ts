const CONSECUTIVE_MATCHES = 31;
const MAX_ATTEMPTS = 120;
const INTERVAL_MS = 1000;
const OBSERVATION_TIMEOUT_MS = 10_000;

export const waitForRollout = async (opts: {
  readonly fetch: typeof globalThis.fetch;
  readonly wait: (durationMs: number) => Promise<void>;
  readonly host: string;
  readonly scriptName: string;
  readonly deploymentId: string;
  readonly observationTimeoutMs?: number;
}): Promise<void> => {
  let matches = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        opts.observationTimeoutMs ?? OBSERVATION_TIMEOUT_MS,
      );
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("rollout observation timed out")),
          { once: true },
        );
      });
      try {
        const response = await Promise.race([
          opts.fetch(`https://${opts.host}/runway/version?attempt=${attempt}`, {
            headers: { "Cache-Control": "no-cache", Connection: "close" },
            signal: controller.signal,
          }),
          aborted,
        ]);
        const body = response.ok
          ? ((await Promise.race([response.json(), aborted])) as { deploymentId?: unknown })
          : undefined;
        matches = body?.deploymentId === opts.deploymentId ? matches + 1 : 0;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      matches = 0;
    }
    if (matches === CONSECUTIVE_MATCHES) return;
    if (attempt < MAX_ATTEMPTS - 1) await opts.wait(INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for Worker ${opts.scriptName} deployment ${opts.deploymentId} to become ready`,
  );
};
