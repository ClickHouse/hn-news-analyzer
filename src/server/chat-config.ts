export interface ChatConfig {
  enabled: boolean;
  apiKey: string;
  model: string;
  baseUrl: string;
}

export function readChatConfig(env = process.env): ChatConfig {
  return {
    enabled: /^(true|1)$/i.test(env.CHAT_ENABLED?.trim() ?? ''),
    apiKey: env.CLICKHOUSE_INFERENCE_API_KEY?.trim() ?? '',
    model: env.CLICKHOUSE_INFERENCE_MODEL?.trim() || 'gemini-3.8-flash',
    baseUrl: (env.CLICKHOUSE_INFERENCE_BASE_URL?.trim() ?? '').replace(/\/+$/, ''),
  };
}

export function chatReady(config: ChatConfig): boolean {
  return config.enabled && Boolean(config.apiKey && config.model && config.baseUrl);
}
