const GITHUB_DEPLOY_BINDINGS = [
  "RUNWAY_GITHUB_APP_ID",
  "RUNWAY_GITHUB_PRIVATE_KEY",
  "RUNWAY_GITHUB_WEBHOOK_SECRET",
] as const;

export const nonGitHubDeployEnv = (
  env: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const result = { ...env, ...overrides };
  for (const name of GITHUB_DEPLOY_BINDINGS) delete result[name];
  if (GITHUB_DEPLOY_BINDINGS.some((name) => result[name] !== undefined)) {
    throw new Error("non-GitHub live smoke inherited GitHub App deploy config");
  }
  return result;
};

export const fetchWorkersDev = async (
  input: string,
  init: RequestInit,
): Promise<{ readonly status: number; readonly text: string }> => {
  const deadline = Date.now() + 60_000;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const response = await fetch(input, init);
    const text = await response.text();
    const startupMiss = response.status === 404 && text.includes("There is nothing here yet");
    if (!startupMiss) return { status: response.status, text };
    if (attempt === 60 || Date.now() >= deadline) {
      throw new Error(`workers.dev did not become reachable: ${text.slice(0, 1024)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("workers.dev did not become reachable within 60 attempts");
};
