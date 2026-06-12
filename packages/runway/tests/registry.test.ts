import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import { loadRegistry } from "../src/registry.ts";

const repo = path.resolve(import.meta.dirname, "../../..");
const example = path.join(repo, "example");

const project = async (
  files: Record<string, string>,
): Promise<{ cwd: string; cleanup(): Promise<void> }> => {
  const cwd = await mkdtemp(path.join(example, ".tmp-registry-test-"));
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), contents);
  }
  return { cwd, cleanup: () => rm(cwd, { recursive: true, force: true }) };
};

const workflow = (
  id: string,
  secrets: ReadonlyArray<string> = [],
): string => `import { cron, workflow } from "runway";

export const ${id.replaceAll("-", "_")} = workflow({
  id: ${JSON.stringify(id)},
  secrets: ${JSON.stringify(secrets)},
  trigger: () => cron("* * * * *"),
}).handler(async () => {});
`;

const defaultWorkflow = (
  id: string,
  secrets: ReadonlyArray<string> = [],
): string => `import { cron, workflow } from "runway";

export default workflow({
  id: ${JSON.stringify(id)},
  secrets: ${JSON.stringify(secrets)},
  trigger: () => cron("* * * * *"),
}).handler(async () => {});
`;

test("loads default, named, and barrel workflow exports", async () => {
  const app = await project({
    ".runway/workflows/one.ts": defaultWorkflow("one", ["ONE_SECRET"]),
    ".runway/workflows/two.ts": workflow("two", ["TWO_SECRET"]),
    ".runway/workflows/index.ts": 'export { two } from "./two.ts";\n',
  });

  try {
    const registry = await loadRegistry(app.cwd);
    const workflows = new Map(registry.map((w) => [w.def.id, w]));

    expect([...workflows.keys()].sort()).toEqual(["one", "two"]);
    expect(workflows.get("one")).toMatchObject({
      path: ".runway/workflows/one.ts",
      exportName: "default",
    });
    expect(workflows.get("two")).toMatchObject({
      path: ".runway/workflows/index.ts",
      exportName: "two",
    });
  } finally {
    await app.cleanup();
  }
});

test("ignores non-workflow and excluded workflow files", async () => {
  const app = await project({
    ".runway/visible.ts": workflow("visible", ["VISIBLE_SECRET"]),
    ".runway/workflows/hello.ts": workflow("hello", ["HELLO_SECRET"]),
    ".runway/workflows/helper.ts": "export const helper = 1;\n",
    ".runway/workflows/ignored.spec.ts": workflow("spec", ["SPEC_SECRET"]),
    ".runway/workflows/ignored.d.ts": workflow("types", ["TYPES_SECRET"]),
  });

  try {
    const registry = await loadRegistry(app.cwd);

    expect(registry.map((w) => w.def.id)).toEqual(["hello"]);
  } finally {
    await app.cleanup();
  }
});

test("rejects empty and duplicate workflow registries", async () => {
  const empty = await project({ ".runway/workflows/helper.ts": "export const helper = 1;\n" });
  const duplicate = await project({
    ".runway/workflows/one.ts": workflow("same"),
    ".runway/workflows/two.ts": workflow("same"),
  });

  try {
    await expect(loadRegistry(empty.cwd)).rejects.toThrow("no workflows found; checked 1 file(s)");
    await expect(loadRegistry(duplicate.cwd)).rejects.toThrow('duplicate workflow id "same"');
  } finally {
    await empty.cleanup();
    await duplicate.cleanup();
  }
});
