import { toFile } from "cloudflare";
import type Cloudflare from "cloudflare";

import { COMPATIBILITY_DATE } from "../../src/internal/runtime/contract.ts";

export const RECOVERY_WEBHOOK_PATH = "/smoke";
export const RECOVERY_SIGNATURE_HEADER = "x-smoke-signature";
export const RECOVERY_SECRET_NAMES = ["HOOK_SECRET", "DRIVER_TOKEN"] as const;

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const recoveryMeasurementCommand = (authenticated: boolean): string => {
  const extras = authenticated
    ? `const placement = execFileSync("hostname", [], { encoding: "utf8" }).trim();
const authEnvironmentClean = !process.env.RUNWAY_GITHUB_TOKEN && !process.env.GIT_ASKPASS &&
  !fs.existsSync("/tmp/runway-git-askpass");`
    : "";
  const fields = authenticated ? ", placement, authEnvironmentClean" : "";
  const source = `const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const metrics = JSON.parse(fs.readFileSync("/tmp/runway-repository-metrics", "utf8"));
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
${extras}
process.stdout.write(JSON.stringify({ head, observedAtMs: Date.now(), metrics${fields} }));`;
  return `node -e ${shellQuote(source)}`;
};

export const recoveryWorkflowSource = (options: {
  readonly workflowId: string;
  readonly authenticated: boolean;
}): string => {
  const measurement = JSON.stringify(recoveryMeasurementCommand(options.authenticated));
  const cold = options.authenticated
    ? `const cold = observe((await run.exec("cold", ${measurement})).stdout);
  await run.do("cold-report", () => cold);`
    : `const coldStartedAtMs = await run.do("cold-started", () => Date.now());
  const cold = observe((await run.exec("cold", ${measurement})).stdout);
  await run.do("cold-report", () => ({ coldStartedAtMs, cold }));`;
  const recoveryStarted = options.authenticated
    ? ""
    : `const recoveryStartedAtMs = await run.do("recovery-started", () => Date.now());\n  `;
  const loss = options.authenticated
    ? `await run.do("loss-report", () => ({ loss, replacementPlacement: null }));`
    : `await run.do("loss-report", () => ({ recoveryStartedAtMs, loss }));`;
  const replayMessage = options.authenticated
    ? "destroyed placement unexpectedly replayed an authenticated command"
    : "destroyed placement unexpectedly replayed a user command";
  return `
import { webhook, workflow } from "runway";

interface SmokeEvent {
  readonly destroyUrl: string;
}

const observe = (output: string) => JSON.parse(output);

export default workflow({
  id: ${JSON.stringify(options.workflowId)},
  secrets: ${JSON.stringify(RECOVERY_SECRET_NAMES)},
  trigger: (ctx) => webhook<SmokeEvent>({
    path: ${JSON.stringify(RECOVERY_WEBHOOK_PATH)},
    secret: ctx.secrets.HOOK_SECRET,
    signatureHeader: ${JSON.stringify(RECOVERY_SIGNATURE_HEADER)},
  }),
}).run(async (run, event) => {
  ${cold}
  await run.do("force-destroy", async () => {
    const response = await fetch(event.destroyUrl, {
      method: "POST",
      headers: {
        authorization: \`Bearer \${run.secrets.DRIVER_TOKEN}\`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ runId: run.runId }),
    });
    if (!response.ok) throw new Error(\`destroy driver returned \${response.status}\`);
    return await response.json();
  });
  ${recoveryStarted}let loss;
  try {
    await run.exec("recovered", ${measurement});
    throw new Error(${JSON.stringify(replayMessage)});
  } catch (error) {
    loss = {
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  ${loss}
});
`;
};

const recoveryDriverSource = (observePlacement: boolean): string => `
const hex = (bytes) => [...new Uint8Array(bytes)]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");

const sandboxId = async (runId) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runId));
  return \`runway-\${hex(digest).slice(0, 32)}\`;
};

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (request.headers.get("authorization") !== \`Bearer \${env.DRIVER_TOKEN}\`) {
      return new Response("unauthorized", { status: 401 });
    }
    const body = await request.json();
    if (!body || typeof body.runId !== "string") {
      return new Response("invalid run id", { status: 400 });
    }
    const id = env.RUNWAY_SANDBOX.idFromName(await sandboxId(body.runId));
    const sandbox = env.RUNWAY_SANDBOX.get(id);
    ${observePlacement ? "const placement = await sandbox.getContainerPlacementId();" : ""}
    await sandbox.destroy();
    return Response.json({ destroyed: true${observePlacement ? ", placement" : ""} });
  },
};
`;

export const uploadRecoveryDriver = async (options: {
  readonly cf: Cloudflare;
  readonly accountId: string;
  readonly driverName: string;
  readonly scriptName: string;
  readonly driverToken: string;
  readonly observePlacement: boolean;
}): Promise<void> => {
  await options.cf.workers.scripts.update(options.driverName, {
    account_id: options.accountId,
    metadata: {
      main_module: "worker.js",
      compatibility_date: COMPATIBILITY_DATE,
      bindings: [
        { type: "secret_text", name: "DRIVER_TOKEN", text: options.driverToken },
        {
          type: "durable_object_namespace",
          name: "RUNWAY_SANDBOX",
          class_name: "Sandbox",
          script_name: options.scriptName,
        },
      ],
    },
    files: [
      await toFile(
        new TextEncoder().encode(recoveryDriverSource(options.observePlacement)),
        "worker.js",
        {
          type: "application/javascript+module",
        },
      ),
    ],
  });
  await options.cf.workers.scripts.subdomain.create(options.driverName, {
    account_id: options.accountId,
    enabled: true,
  });
};
