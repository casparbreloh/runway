import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Registry } from "../../src/internal/publish/registry.ts";
import type { WorkflowDefinition } from "../../src/workflow.ts";

const WORKFLOW_PATH = ".runway/workflows/smoke.ts";

export const fixtureRegistry = (cwd: string, def: WorkflowDefinition): Registry => [
  {
    path: path.join(cwd, WORKFLOW_PATH),
    exportName: "default",
    def,
  },
];

export const writeWorkflowFixture = async (
  cwd: string,
  packageName: string,
  source: string,
): Promise<string> => {
  const workflowPath = path.join(cwd, WORKFLOW_PATH);
  await mkdir(path.dirname(workflowPath), { recursive: true });
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: packageName }));
  await writeFile(workflowPath, source);
  return workflowPath;
};
