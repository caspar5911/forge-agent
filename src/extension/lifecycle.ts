/** Extension lifecycle helpers (settings sync + keep-alive). */
import * as vscode from 'vscode';
import { pingLLM } from '../llm/client';

let keepAliveTimer: NodeJS.Timeout | null = null;

/** Read VS Code settings and sync them into env vars for the LLM client. */
export function applyLLMSettingsToEnv(): void {
  const config = vscode.workspace.getConfiguration('forge');
  const endpoint = config.get<string>('llmEndpoint');
  const model = config.get<string>('llmModel');
  const apiKey = config.get<string>('llmApiKey');
  const timeoutMs = config.get<number>('llmTimeoutMs');

  if (endpoint && endpoint.trim().length > 0) {
    process.env.FORGE_LLM_ENDPOINT = endpoint.trim();
  }
  if (model && model.trim().length > 0) {
    process.env.FORGE_LLM_MODEL = model.trim();
  }
  if (apiKey && apiKey.trim().length > 0) {
    process.env.FORGE_LLM_API_KEY = apiKey.trim();
  }
  if (timeoutMs && Number.isFinite(timeoutMs)) {
    process.env.FORGE_LLM_TIMEOUT_MS = String(timeoutMs);
  }
}

/** Keep the LLM warm by pinging it on a timer. */
export function startKeepAlive(): void {
  const config = vscode.workspace.getConfiguration('forge');
  const intervalSeconds = config.get<number>('keepAliveSeconds') ?? 0;
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (!intervalSeconds || intervalSeconds <= 0) {
    return;
  }
  keepAliveTimer = setInterval(() => {
    void pingLLM().catch(() => undefined);
  }, intervalSeconds * 1000);
}
