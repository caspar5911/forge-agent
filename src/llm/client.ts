/**
 * LangChain-backed OpenAI-compatible chat client.
 *
 * Forge intentionally targets *OpenAI-compatible* servers (vLLM, Ollama, OpenAI API).
 * We keep higher-level orchestration (planning, file updates, validation loops)
 * inside Forge, but delegate the low-level HTTP + streaming details to LangChain.
 */
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { LLMConfig, ResolvedLLMConfig } from './config';
import { resolveLLMConfig } from './config';
import { parseTokenLimitFromError, trimMessagesToTokenBudget } from './tokenBudget';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/**
 * Minimal response shape used throughout Forge (mirrors the parts of the OpenAI response we read).
 * Keeping this stable avoids rewriting the rest of the extension.
 */
export type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

type CachedModel = {
  model: ChatOpenAI;
  streaming: boolean;
};

const modelCache = new Map<string, CachedModel>();

/** Ping the LLM /models endpoint to keep it warm. */
export async function pingLLM(config: LLMConfig = {}): Promise<void> {
  const resolved = resolveLLMConfig(config);
  const url = new URL(resolved.endpoint.replace(/\/$/, '') + '/models');

  const timeout = withTimeout(resolved.timeoutMs, undefined);
  try {
    const response = await fetch(url, { method: 'GET', signal: timeout.signal });
    // We don't care about the payload, only whether the endpoint is reachable.
    if (!response.ok) {
      const body = await safeReadText(response);
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
  } finally {
    timeout.dispose();
  }
}

/** Call a non-streaming chat completion request. */
export async function callChatCompletion(
  config: LLMConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<ChatCompletionResponse> {
  const resolved = resolveLLMConfig(config);
  return requestChatCompletion(resolved, messages, signal);
}

/** Call a streaming chat completion request and emit deltas. */
export async function callChatCompletionStream(
  config: LLMConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const resolved = resolveLLMConfig(config);
  return requestChatCompletionStream(resolved, messages, onDelta, signal);
}

async function requestChatCompletion(
  config: ResolvedLLMConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  retryOnTokenLimit: boolean = true
): Promise<ChatCompletionResponse> {
  const prepared = applyTokenBudget(config, messages);
  const model = getChatModel(config, { streaming: false });
  const timeout = withTimeout(config.timeoutMs, signal);

  try {
    const result = await model.invoke(toLangChainMessages(prepared.messages), { signal: timeout.signal });
    const content = normalizeLangChainContent((result as unknown as AIMessage).content);
    return { choices: [{ message: { content } }] };
  } catch (error) {
    // When vLLM/Ollama reject an oversized prompt, they commonly include the max
    // context length in the error message. We opportunistically trim and retry once.
    if (retryOnTokenLimit) {
      const maxTokens = parseTokenLimitFromError(String(error));
      if (maxTokens) {
        const trimmed = trimMessagesToTokenBudget(messages, maxTokens);
        return requestChatCompletion({ ...config, maxInputTokens: maxTokens }, trimmed.messages, signal, false);
      }
    }
    throw error;
  } finally {
    timeout.dispose();
  }
}

async function requestChatCompletionStream(
  config: ResolvedLLMConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  retryOnTokenLimit: boolean = true
): Promise<string> {
  const prepared = applyTokenBudget(config, messages);
  const model = getChatModel(config, { streaming: true });
  const timeout = withTimeout(config.timeoutMs, signal);

  try {
    const stream = await model.stream(toLangChainMessages(prepared.messages), { signal: timeout.signal });
    let fullText = '';
    for await (const chunk of stream) {
      const delta = normalizeLangChainContent((chunk as unknown as AIMessage).content);
      if (!delta) {
        continue;
      }
      fullText += delta;
      onDelta(delta);
    }
    return fullText;
  } catch (error) {
    if (retryOnTokenLimit) {
      const maxTokens = parseTokenLimitFromError(String(error));
      if (maxTokens) {
        const trimmed = trimMessagesToTokenBudget(messages, maxTokens);
        return requestChatCompletionStream({ ...config, maxInputTokens: maxTokens }, trimmed.messages, onDelta, signal, false);
      }
    }
    throw error;
  } finally {
    timeout.dispose();
  }
}

function applyTokenBudget(
  config: ResolvedLLMConfig,
  messages: ChatMessage[]
): { messages: ChatMessage[]; trimmed: boolean; estimatedTokens: number } {
  if (!config.maxInputTokens) {
    return { messages, trimmed: false, estimatedTokens: 0 };
  }
  return trimMessagesToTokenBudget(messages, config.maxInputTokens);
}

function getChatModel(config: ResolvedLLMConfig, options: { streaming: boolean }): ChatOpenAI {
  // OpenAI client expects a baseURL without a trailing slash.
  const baseURL = config.endpoint.replace(/\/$/, '');

  // Many local OpenAI-compatible servers ignore auth, but OpenAI requires it.
  // We provide a harmless placeholder key for local setups when one isn't set.
  const apiKey = config.apiKey ?? 'local';

  const cacheKey = `${baseURL}|${config.model}|${apiKey}|${config.timeoutMs}|${options.streaming ? 'stream' : 'nostream'}`;
  const cached = modelCache.get(cacheKey);
  if (cached && cached.streaming === options.streaming) {
    return cached.model;
  }

  const model = new ChatOpenAI({
    modelName: config.model,
    temperature: 0,
    streaming: options.streaming,
    openAIApiKey: apiKey,
    timeout: config.timeoutMs,
    configuration: {
      baseURL
    }
  });

  modelCache.set(cacheKey, { model, streaming: options.streaming });
  return model;
}

function toLangChainMessages(messages: ChatMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (message.role === 'system') {
      return new SystemMessage(message.content);
    }
    if (message.role === 'assistant') {
      return new AIMessage(message.content);
    }
    return new HumanMessage(message.content);
  });
}

function normalizeLangChainContent(content: unknown): string {
  // LangChain content can be a string or an array of rich content parts.
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return content == null ? '' : String(content);
}

function withTimeout(
  timeoutMs: number,
  signal?: AbortSignal
): { signal?: AbortSignal; dispose: () => void } {
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!hasTimeout && !signal) {
    return { signal: undefined, dispose: () => undefined };
  }

  const controller = new AbortController();
  let timeout: NodeJS.Timeout | null = null;
  const onAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  if (hasTimeout) {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
  }

  return {
    signal: controller.signal,
    dispose: () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
