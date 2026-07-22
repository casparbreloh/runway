import { test } from "vitest";

import { runRecovery } from "./recovery-runner.ts";

test("reports repository placement loss without replaying a command", async () => {
  await runRecovery({ type: "repository" });
});
