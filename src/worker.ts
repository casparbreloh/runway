// The deployed Worker. It hosts the workflow entrypoints and the front router that turns
// inbound webhooks/crons into workflow instances. wrangler.jsonc binds each `class_name`
// here to its workflow, and the Sandbox class to the container.
import linearToPr from "../workflows/linear-to-pr.ts";
import { createRouter, toEntrypoint } from "./index.ts";

export { Sandbox } from "@cloudflare/sandbox";

export const LinearToPr = toEntrypoint(linearToPr);

export default createRouter([linearToPr]);
