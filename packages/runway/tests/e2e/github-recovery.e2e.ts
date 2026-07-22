import process from "node:process";

import { test } from "vitest";

import { runRecovery } from "./recovery-runner.ts";

test.skipIf(process.env.RUNWAY_LIVE_GITHUB_RECOVERY !== "1")(
  "reports authenticated GitHub placement loss without exposing or replaying credentials",
  async () => {
    await runRecovery({ type: "github" });
  },
);
