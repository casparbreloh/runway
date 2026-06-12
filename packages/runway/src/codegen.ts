import path from "node:path";

import { secretNamesOf } from "./registry.ts";
import type { RegisteredWorkflow } from "./types.ts";
import type { Registry } from "./types.ts";
import { validateRegistry } from "./validate.ts";

export const COMPATIBILITY_DATE = "2026-06-06";
export const WORKFLOW_NAME = "runway";
export const WORKFLOW_BINDING = "WORKFLOWS";
export const LOADER_BINDING = "LOADER";
export const SANDBOX_BINDING = "Sandbox";
export const SANDBOX_CLASS = "Sandbox";
export const SANDBOX_IMAGE = "docker.io/cloudflare/sandbox:0.12.1";
export const SANDBOX_MIGRATION_TAG = "runway-sandbox-v1";
export const DYNAMIC_WORKFLOW_CLASS = "DynamicWorkflow";
export const TENANT_WORKFLOW_CLASS = "TenantWorkflow";

export const cronsOf = (registry: Registry): ReadonlyArray<string> =>
  registry.flatMap((w) => (w.def.trigger.type === "cron" ? [w.def.trigger.expression] : []));

const toPosix = (p: string): string => p.split(path.sep).join(path.posix.sep);

const relImport = (cwd: string, module: string): string => {
  const rel = path.posix.relative(toPosix(cwd), toPosix(module));
  return rel.startsWith("./") || rel.startsWith("../") ? rel : `./${rel}`;
};

const workflowRef = (index: number, exportName: string): string =>
  exportName === "default" ? `__m${index}.default` : `__m${index}[${JSON.stringify(exportName)}]`;

export const generateDynamicWorker = (
  workflow: RegisteredWorkflow,
  opts: { cwd: string },
): string => {
  const ref = workflowRef(0, workflow.exportName);
  return `import * as __m0 from ${JSON.stringify(relImport(opts.cwd, path.resolve(opts.cwd, workflow.path)))};
import { createWorkflowWorker, toEntrypoint } from "runway/worker";

export class ${TENANT_WORKFLOW_CLASS} extends toEntrypoint(${ref}) {}

export default createWorkflowWorker();
`;
};

export const generateWorker = (
  registry: Registry,
  opts: {
    cwd: string;
    modules: Readonly<Record<string, string>>;
    workflowLoaders: Readonly<Record<string, string>>;
  },
): string => {
  validateRegistry(registry);
  const imports = registry
    .map(
      (w, i) =>
        `import * as __m${i} from ${JSON.stringify(relImport(opts.cwd, path.resolve(opts.cwd, w.path)))};`,
    )
    .join("\n");
  const routes = registry
    .map(
      (w, i) =>
        `  { id: ${JSON.stringify(w.def.id)}, trigger: ${workflowRef(i, w.exportName)}.trigger },`,
    )
    .join("\n");
  const modules = JSON.stringify(opts.modules);
  const workflowLoaders = JSON.stringify(opts.workflowLoaders);
  const secretNames = JSON.stringify(secretNamesOf(registry));
  return `${imports}
import {
  createDynamicWorkflowEntrypoint,
  DynamicWorkflowBinding,
  wrapWorkflowBinding,
  type WorkflowRunner,
} from "@cloudflare/dynamic-workflows";
import { createRouter, type RouterEntry, type WorkflowStarter } from "runway/worker";

export { DynamicWorkflowBinding };
export { Sandbox } from "@cloudflare/sandbox";

interface LoaderStub {
  getEntrypoint(name?: string): { fetch(req: Request): Promise<Response>; run?: unknown };
}

interface LoaderBinding {
  get(
    name: string,
    init: () => Promise<{
      compatibilityDate: string;
      compatibilityFlags?: ReadonlyArray<string>;
      mainModule: string;
      modules: Record<string, string>;
      env: Record<string, unknown>;
    }>,
  ): LoaderStub;
}

interface Env {
  ${LOADER_BINDING}: LoaderBinding;
}

const modules: Record<string, string> = ${modules};
const workflowLoaders: Record<string, string> = ${workflowLoaders};
const secretNames: ReadonlyArray<string> = ${secretNames};

const loadWorkflow = (env: Env, workflowId: string): LoaderStub => {
  const loaderId = workflowLoaders[workflowId];
  if (!loaderId) throw new Error(\`unknown workflow: \${workflowId}\`);
  const code = modules[loaderId];
  if (!code) throw new Error(\`unknown workflow version: \${loaderId}\`);
  const parentEnv = env as unknown as Record<string, unknown>;
  return env.${LOADER_BINDING}.get(loaderId, async () => ({
    compatibilityDate: ${JSON.stringify(COMPATIBILITY_DATE)},
    compatibilityFlags: ["nodejs_compat"],
    mainModule: "index.js",
    modules: { "index.js": code },
    env: {
      ...Object.fromEntries(secretNames.map((name) => [name, parentEnv[name]])),
      ${JSON.stringify(SANDBOX_BINDING)}: parentEnv[${JSON.stringify(SANDBOX_BINDING)}],
      ${WORKFLOW_BINDING}: wrapWorkflowBinding({ workflowId }),
    },
  }));
};

export const ${DYNAMIC_WORKFLOW_CLASS} = createDynamicWorkflowEntrypoint<Env>(
  async ({ env, metadata }) => {
    const workflowId = metadata.workflowId;
    if (typeof workflowId !== "string") throw new Error("missing workflow metadata");
    return loadWorkflow(env, workflowId).getEntrypoint(${JSON.stringify(TENANT_WORKFLOW_CLASS)}) as unknown as WorkflowRunner;
  },
);

const starter: WorkflowStarter = {
  async start(entry: RouterEntry, event: unknown, env: unknown) {
    const response = await loadWorkflow(env as Env, entry.id).getEntrypoint().fetch(
      new Request("https://runway.local/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      }),
    );
    if (!response.ok) throw new Error(await response.text());
    return await response.json() as { id: string };
  },
};

export default createRouter([
${routes}
], starter);
`;
};
