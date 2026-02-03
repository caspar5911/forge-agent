/** LLM configuration types and defaults. */

export type LLMConfig = {
  endpoint?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
};

export type ResolvedLLMConfig = {
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
};

export const DEFAULT_LLM_ENDPOINT = 'http://127.0.0.1:8000/v1';
export const DEFAULT_LLM_MODEL = 'Qwen/Qwen2.5-Coder-32B-Instruct-AWQ';
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Resolve LLM config by merging overrides, env vars, and defaults. */
export function resolveLLMConfig(overrides: LLMConfig = {}): ResolvedLLMConfig {
  const endpoint = overrides.endpoint ?? process.env.FORGE_LLM_ENDPOINT ?? DEFAULT_LLM_ENDPOINT;
  const model = overrides.model ?? process.env.FORGE_LLM_MODEL ?? DEFAULT_LLM_MODEL;
  const apiKey = overrides.apiKey ?? process.env.FORGE_LLM_API_KEY;
  const envTimeout = process.env.FORGE_LLM_TIMEOUT_MS
    ? Number(process.env.FORGE_LLM_TIMEOUT_MS)
    : undefined;
  const timeoutMs = overrides.timeoutMs ?? envTimeout ?? DEFAULT_TIMEOUT_MS;

  return {
    endpoint,
    model,
    apiKey: apiKey && apiKey.trim().length > 0 ? apiKey : undefined,
    timeoutMs
  };
}
