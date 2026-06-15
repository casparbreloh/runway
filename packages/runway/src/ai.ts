export interface ModelConfig {
  readonly name: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export interface AiOptions {
  readonly model: ModelConfig;
  readonly system?: string;
  readonly prompt: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

interface OpenRouterMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

interface OpenRouterResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?: unknown;
    };
  }>;
  readonly error?: {
    readonly message?: string;
  };
}

const textOf = (content: unknown): string | undefined => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
  return text.length > 0 ? text : undefined;
};

export const runAi = async (opts: AiOptions): Promise<string> => {
  const messages: OpenRouterMessage[] = [
    ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
    { role: "user", content: opts.prompt },
  ];
  const response = await fetch(
    `${opts.model.baseUrl ?? "https://openrouter.ai/api/v1"}/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.model.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model.name,
        messages,
        ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
        ...(opts.maxTokens === undefined ? {} : { max_tokens: opts.maxTokens }),
      }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as OpenRouterResponse;
  if (!response.ok) {
    throw new Error(body.error?.message ?? `OpenRouter request failed: ${response.status}`);
  }
  const text = textOf(body.choices?.[0]?.message?.content);
  if (!text) throw new Error("OpenRouter response did not include text");
  return text.trim();
};
