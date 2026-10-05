// The fixed list of AI providers this app can use. A key is only ever sent to
// the base URL listed here, so a typed-in or pasted URL can never receive it.
// Adding a provider means adding one entry here, one Keychain account in
// server/core/secrets.mjs, and (if its API is not OpenAI's Responses API) reusing
// the chat-completions adapter.
export const AI_PROVIDERS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    api: "responses",
    account: "openai-api",
    defaultModel: "gpt-4.1-mini",
    keyPage: "https://platform.openai.com/api-keys",
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "chat",
    account: "ai-openrouter",
    defaultModel: "google/gemma-4-31b-it:free",
    keyPage: "https://openrouter.ai/keys",
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    api: "chat",
    account: "ai-anthropic",
    defaultModel: "claude-sonnet-4-5",
    keyPage: "https://console.anthropic.com/settings/keys",
  },
};

export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS);
