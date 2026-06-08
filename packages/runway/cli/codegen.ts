import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { Discovered } from "./discover.ts";

const COMPAT_DATE = "2026-06-06";
const SANDBOX_IMAGE = "docker.io/cloudflare/sandbox:0.11.0";

const idOf = (file: string, id?: string): string => {
  if (id) return id;
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.[cm]?[jt]s$/, "");
};
const bindingOf = (id: string): string => id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
const classOf = (id: string): string =>
  id
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

interface Resolved {
  readonly id: string;
  readonly binding: string;
  readonly cls: string;
  readonly importPath: string;
}

const resolveDefs = (cwd: string, defs: Discovered[]): Resolved[] =>
  defs.map((d) => {
    const id = idOf(d.file, d.def.id);
    const rel = relative(join(cwd, ".runway"), join(cwd, d.file)).replaceAll("\\", "/");
    return {
      id,
      binding: bindingOf(id),
      cls: classOf(id),
      importPath: rel.startsWith(".") ? rel : `./${rel}`,
    };
  });

const collectSecrets = (defs: Discovered[]): string[] =>
  [...new Set(defs.flatMap((d) => d.def.secrets ?? []))].sort();

const workerSource = (rs: Resolved[]): string => {
  const imports = rs.map((r, i) => `import w${i} from ${JSON.stringify(r.importPath)};`).join("\n");
  const classes = rs.map((r, i) => `export const ${r.cls} = toEntrypoint(w${i});`).join("\n");
  const entries = rs
    .map((r, i) => `  { trigger: w${i}.trigger, binding: ${JSON.stringify(r.binding)} },`)
    .join("\n");
  return [
    `import { Sandbox, createRouter, toEntrypoint } from "runway/worker";`,
    imports,
    ``,
    `export { Sandbox };`,
    classes,
    ``,
    `export default createRouter([`,
    entries,
    `]);`,
    ``,
  ].join("\n");
};

const wranglerConfig = (name: string, rs: Resolved[], secrets: string[]): string =>
  `${JSON.stringify(
    {
      name,
      main: "worker.gen.ts",
      compatibility_date: COMPAT_DATE,
      compatibility_flags: ["nodejs_compat"],
      workflows: rs.map((r) => ({ name: r.id, binding: r.binding, class_name: r.cls })),
      ...(secrets.length > 0 ? { secrets: { required: secrets } } : {}),
      containers: [
        {
          class_name: "Sandbox",
          image: SANDBOX_IMAGE,
          instance_type: "standard-1",
          max_instances: 5,
        },
      ],
      durable_objects: { bindings: [{ class_name: "Sandbox", name: "Sandbox" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Sandbox"] }],
      limits: { cpu_ms: 300000 },
    },
    null,
    2,
  )}\n`;

const envTypes = (rs: Resolved[], secrets: string[]): string =>
  [
    `declare global {`,
    `  interface Env {`,
    ...rs.map((r) => `    readonly ${r.binding}: Workflow;`),
    ...secrets.map((s) => `    readonly ${s}: string;`),
    `  }`,
    `}`,
    ``,
    `export {};`,
    ``,
  ].join("\n");

const pkgName = async (cwd: string): Promise<string> => {
  const raw = await readFile(join(cwd, "package.json"), "utf8").catch(() => "");
  const name = raw ? (JSON.parse(raw) as { name?: string }).name : undefined;
  return name
    ? name
        .replace(/^@[^/]+\//, "")
        .replace(/[^a-z0-9-]/gi, "-")
        .toLowerCase()
    : "runway-app";
};

export const generate = async (cwd: string, defs: Discovered[]): Promise<void> => {
  const rs = resolveDefs(cwd, defs);
  const secrets = collectSecrets(defs);
  const dir = join(cwd, ".runway");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "worker.gen.ts"), workerSource(rs));
  await writeFile(join(dir, "wrangler.gen.jsonc"), wranglerConfig(await pkgName(cwd), rs, secrets));
  await writeFile(join(dir, "runway-env.d.ts"), envTypes(rs, secrets));
};
