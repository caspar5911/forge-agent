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
  const planModel = config.get<string>('llmPlanModel');
  const planEndpoint = config.get<string>('llmPlanEndpoint');
  const planApiKey = config.get<string>('llmPlanApiKey');
  const verifyModel = config.get<string>('llmVerifyModel');
  const verifyEndpoint = config.get<string>('llmVerifyEndpoint');
  const verifyApiKey = config.get<string>('llmVerifyApiKey');
  const summaryModel = config.get<string>('llmSummaryModel');
  const summaryEndpoint = config.get<string>('llmSummaryEndpoint');
  const summaryApiKey = config.get<string>('llmSummaryApiKey');

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
  if (planModel && planModel.trim().length > 0) {
    process.env.FORGE_LLM_MODEL_PLAN = planModel.trim();
  }
  if (planEndpoint && planEndpoint.trim().length > 0) {
    process.env.FORGE_LLM_ENDPOINT_PLAN = planEndpoint.trim();
  }
  if (planApiKey && planApiKey.trim().length > 0) {
    process.env.FORGE_LLM_API_KEY_PLAN = planApiKey.trim();
  }
  if (verifyModel && verifyModel.trim().length > 0) {
    process.env.FORGE_LLM_MODEL_VERIFY = verifyModel.trim();
  }
  if (verifyEndpoint && verifyEndpoint.trim().length > 0) {
    process.env.FORGE_LLM_ENDPOINT_VERIFY = verifyEndpoint.trim();
  }
  if (verifyApiKey && verifyApiKey.trim().length > 0) {
    process.env.FORGE_LLM_API_KEY_VERIFY = verifyApiKey.trim();
  }
  if (summaryModel && summaryModel.trim().length > 0) {
    process.env.FORGE_LLM_MODEL_SUMMARY = summaryModel.trim();
  }
  if (summaryEndpoint && summaryEndpoint.trim().length > 0) {
    process.env.FORGE_LLM_ENDPOINT_SUMMARY = summaryEndpoint.trim();
  }
  if (summaryApiKey && summaryApiKey.trim().length > 0) {
    process.env.FORGE_LLM_API_KEY_SUMMARY = summaryApiKey.trim();
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
