import * as Cloudflare from "alchemy/Cloudflare";

/**
 * The Runway D1 database, bound to the Worker as `DB`.
 */
export const Db = Cloudflare.D1Database("DB", { migrationsDir: "migrations" });

export const SessionsBucket = Cloudflare.R2Bucket("SESSIONS");
