import { createRouter, toEntrypoint } from "runway";

// The deployed Worker: it hosts the workflow entrypoints and the front router that turns
// inbound webhooks/crons into workflow instances. wrangler.jsonc binds each class_name here.
import linearToPr from "./workflows/linear-to-pr.ts";

export { Sandbox } from "runway";

export const LinearToPr = toEntrypoint(linearToPr);

export default createRouter([linearToPr]);
