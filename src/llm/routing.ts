/** Optional model routing for plan/verify/summary calls. */
import type { LLMConfig } from './config';

export type RoutedModelKind = 'plan' | 'verify' | 'summary';

export function getRoutedConfig(kind: RoutedModelKind): LLMConfig {
  const envKey =
    kind === 'plan'
      ? process.env.FORGE_LLM_MODEL_PLAN
      : kind === 'verify'
        ? process.env.FORGE_LLM_MODEL_VERIFY
        : process.env.FORGE_LLM_MODEL_SUMMARY;

  if (envKey && envKey.trim().length > 0) {
    return { model: envKey.trim() };
  }
  return {};
}
