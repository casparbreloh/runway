import { createRouter, toEntrypoint } from "runway";

import linearToPr from "./workflows/linear-to-pr.ts";

export { Sandbox } from "runway";

export const LinearToPr = toEntrypoint(linearToPr);

export default createRouter([linearToPr]);
