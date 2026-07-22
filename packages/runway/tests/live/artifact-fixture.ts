export const artifactWorkflowSource = (bodyVersion: "v1" | "v2", scriptName: string): string => `
import { webhook, workflow } from "runway";

interface SmokeEvent {
  readonly sleepMs: number;
  readonly expectedSecretHash: string;
  readonly rejectedSecretHash: string;
  readonly printSecret: boolean;
}

const hash = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export default workflow({
  id: "immutable-smoke",
  secrets: ["HOOK_SECRET", "SMOKE_SECRET"],
  trigger: (ctx) => webhook<SmokeEvent>({
    path: "/smoke",
    secret: ctx.secrets.HOOK_SECRET,
    signatureHeader: "x-smoke-signature",
  }),
}).run(async (run, event) => {
  await run.do("version-before", () => ({ bodyVersion: ${JSON.stringify(bodyVersion)}, scriptName: ${JSON.stringify(scriptName)} }));
  if (event.sleepMs > 0) await run.sleep("hold-v1", event.sleepMs);
  await run.do("version-after", () => ({ bodyVersion: ${JSON.stringify(bodyVersion)} }));
  const actualSecretHash = await hash(run.secrets.SMOKE_SECRET);
  await run.do("secret-state", () => ({
    matchesExpected: actualSecretHash === event.expectedSecretHash,
    matchesRejected: actualSecretHash === event.rejectedSecretHash,
  }));
  if (event.printSecret) {
    await run.exec("secret-output", {
      command: ${JSON.stringify(`printf '%s\n' "$RUNWAY_SMOKE_SECRET"`)},
      env: { RUNWAY_SMOKE_SECRET: run.secrets.SMOKE_SECRET },
    });
  }
});
`;
