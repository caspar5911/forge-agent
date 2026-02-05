/** Optional model routing for plan/verify/summary calls. */
import type { LLMConfig } from './config';

export type RoutedModelKind = 'plan' | 'verify' | 'summary';

/** Resolve a model override for a specific LLM role (plan/verify/summary). */
export function getRoutedConfig(kind: RoutedModelKind): LLMConfig {
  const envModel =
    kind === 'plan'
      ? process.env.FORGE_LLM_MODEL_PLAN
      : kind === 'verify'
        ? process.env.FORGE_LLM_MODEL_VERIFY
        : process.env.FORGE_LLM_MODEL_SUMMARY;
  const envEndpoint =
    kind === 'plan'
      ? process.env.FORGE_LLM_ENDPOINT_PLAN
      : kind === 'verify'
        ? process.env.FORGE_LLM_ENDPOINT_VERIFY
        : process.env.FORGE_LLM_ENDPOINT_SUMMARY;
  const envApiKey =
    kind === 'plan'
      ? process.env.FORGE_LLM_API_KEY_PLAN
      : kind === 'verify'
        ? process.env.FORGE_LLM_API_KEY_VERIFY
        : process.env.FORGE_LLM_API_KEY_SUMMARY;

  const config: LLMConfig = {};
  if (envModel && envModel.trim().length > 0) {
    config.model = envModel.trim();
  }
  if (envEndpoint && envEndpoint.trim().length > 0) {
    config.endpoint = envEndpoint.trim();
  }
  if (envApiKey && envApiKey.trim().length > 0) {
    config.apiKey = envApiKey.trim();
  }

  return config;
}
