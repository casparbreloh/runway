import { subscriptionProvider } from "./subscription.ts";

export const codexSubscription = subscriptionProvider({
  name: "codex-subscription",
  credentialKey: "codex",
  configDirEnv: "CODEX_HOME",
  configDir: "/work/.codex",
  authPath: "/work/.codex/auth.json",
});
