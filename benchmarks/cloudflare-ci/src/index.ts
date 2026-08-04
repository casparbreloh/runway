import { CiSandbox } from "@cloudflare/ci/worker";

import { CI } from "../cloudflare.ci";
import type { Bindings } from "../env";

export { CiSandbox, CI };

export default {
  fetch() {
    return new Response("ok");
  },
} satisfies ExportedHandler<Bindings>;
