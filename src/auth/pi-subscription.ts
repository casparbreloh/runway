import { subscriptionProvider } from "./subscription.ts";

export const piSubscription = subscriptionProvider({
  name: "pi-subscription",
  credentialKey: "pi",
  configDirEnv: "PI_CODING_AGENT_DIR",
  configDir: "/work/.pi-agent",
  authPath: "/work/.pi-agent/auth.json",
});
