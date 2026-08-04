import type { CiBindings } from "@cloudflare/ci/worker";

export type Bindings = CiBindings & CloudflareBindings;
