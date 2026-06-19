import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SCRIPT_NAME = "runway";
const SCRIPT_NAME_ENV = "RUNWAY_SCRIPT_NAME";

export const bindingOf = (id: string): string => id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

const slugOf = (value: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[/\\]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) throw new Error(`invalid Runway script name ${JSON.stringify(value)}`);
  return slug;
};

const repoScriptNameOf = (identity: string): string => {
  const slug = slugOf(identity);
  return slug === DEFAULT_SCRIPT_NAME || slug.startsWith(`${DEFAULT_SCRIPT_NAME}-`)
    ? slug
    : `${DEFAULT_SCRIPT_NAME}-${slug}`;
};

const packageNameOf = async (cwd: string): Promise<string | undefined> => {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as {
      name?: unknown;
    };
    return typeof pkg.name === "string" && pkg.name.trim() ? pkg.name : undefined;
  } catch {
    return undefined;
  }
};

export const resolveScriptName = async (opts: {
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
}): Promise<string> => {
  const explicit = opts.env?.[SCRIPT_NAME_ENV];
  if (explicit) return slugOf(explicit);
  const packageName = await packageNameOf(opts.cwd);
  if (packageName) return repoScriptNameOf(packageName);
  return repoScriptNameOf(path.basename(opts.cwd));
};
