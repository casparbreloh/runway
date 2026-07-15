import path from "node:path";

import type { RegisteredWorkflow, Registry } from "./types.ts";
import { validateRegistry } from "./validate.ts";
import { DYNAMIC_WORKFLOW_CLASS, RUNWAY_WORKFLOW_CLASS } from "./worker-contract.ts";

const toPosix = (value: string): string => value.split(path.sep).join(path.posix.sep);

const relImport = (cwd: string, module: string): string => {
  const relative = path.posix.relative(toPosix(cwd), toPosix(module));
  return relative.startsWith("./") || relative.startsWith("../") ? relative : `./${relative}`;
};

const workflowRef = (exportName: string): string =>
  exportName === "default"
    ? "workflowModule.default"
    : `workflowModule[${JSON.stringify(exportName)}]`;

export const generateDynamicWorker = (
  workflow: RegisteredWorkflow,
  opts: { cwd: string },
): string => {
  const ref = workflowRef(workflow.exportName);
  return `import * as workflowModule from ${JSON.stringify(relImport(opts.cwd, path.resolve(opts.cwd, workflow.path)))};
import { createWorkflowWorker, toEntrypoint } from "runway/runtime";

const workflow = ${ref};

export class ${RUNWAY_WORKFLOW_CLASS} extends toEntrypoint(workflow) {}

export default createWorkflowWorker(workflow);
`;
};

export const generateHost = (
  registry: Registry,
  opts: {
    scriptName: string;
    workflowArtifacts: Readonly<Record<string, string>>;
    deploymentId: string;
    secretSnapshotKey: string;
  },
): string => {
  validateRegistry(registry);
  const routes = registry.map((workflow) => {
    const artifactVersion = opts.workflowArtifacts[workflow.def.id]!;
    return workflow.def.trigger.type === "webhook"
      ? {
          id: workflow.def.id,
          artifactVersion,
          type: "webhook",
          path: workflow.def.trigger.path,
        }
      : {
          id: workflow.def.id,
          artifactVersion,
          type: "cron",
          expression: workflow.def.trigger.expression,
        };
  });
  const config = JSON.stringify({
    scriptName: opts.scriptName,
    deploymentId: opts.deploymentId,
    secretSnapshotKey: opts.secretSnapshotKey,
    routes,
  });
  return `import { DynamicWorkflowBinding } from "@cloudflare/dynamic-workflows";
import { Sandbox } from "@cloudflare/sandbox";
import {
  RunwayRunnerBinding,
  createDynamicWorkflow,
  createHost,
} from "runway:host-runtime";

export { DynamicWorkflowBinding, RunwayRunnerBinding, Sandbox };

const config = ${config};

export const ${DYNAMIC_WORKFLOW_CLASS} = createDynamicWorkflow(config);

export default createHost(config);
`;
};
