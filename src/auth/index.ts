import type { AuthProvider } from "./auth-provider.ts";
import { codexSubscription } from "./codex-subscription.ts";
import { openaiApiKey } from "./openai-api-key.ts";
import { piSubscription } from "./pi-subscription.ts";

export const authProviders: Record<string, AuthProvider> = {
  "codex-subscription": codexSubscription,
  "pi-subscription": piSubscription,
  "openai-api-key": openaiApiKey,
};

export type { AuthProvider } from "./auth-provider.ts";
