import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SCRIPT_NAME = "runway";
const MAX_SCRIPT_NAME_LENGTH = 63;
const SCRIPT_NAME_ENV = "RUNWAY_SCRIPT_NAME";

const ensureScriptNameLength = (name: string, value: string): void => {
  if (name.length > MAX_SCRIPT_NAME_LENGTH) {
    throw new Error(
      `invalid Runway script name ${JSON.stringify(value)}: normalized name ${JSON.stringify(name)} exceeds ${MAX_SCRIPT_NAME_LENGTH} characters`,
    );
  }
};

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
  ensureScriptNameLength(slug, value);
  return slug;
};

const repoScriptNameOf = (identity: string): string => {
  const slug = slugOf(identity);
  const name =
    slug === DEFAULT_SCRIPT_NAME || slug.startsWith(`${DEFAULT_SCRIPT_NAME}-`)
      ? slug
      : `${DEFAULT_SCRIPT_NAME}-${slug}`;
  ensureScriptNameLength(name, identity);
  return name;
};

const isMissingFile = (err: unknown): boolean =>
  err !== null &&
  typeof err === "object" &&
  "code" in err &&
  (err as { code?: unknown }).code === "ENOENT";

const packageNameOf = async (cwd: string): Promise<string | undefined> => {
  try {
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as {
      name?: unknown;
      runway?: { name?: unknown };
    };
    if (typeof pkg.runway?.name === "string" && pkg.runway.name.trim()) return pkg.runway.name;
    return typeof pkg.name === "string" && pkg.name.trim() ? pkg.name : undefined;
  } catch (err) {
    if (isMissingFile(err)) return undefined;
    throw err;
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
