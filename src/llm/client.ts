/** Minimal OpenAI-compatible chat client over HTTP/S. */
import * as http from 'http';
import * as https from 'https';
import type { LLMConfig, ResolvedLLMConfig } from './config';
import { resolveLLMConfig } from './config';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

/** Ping the LLM /models endpoint to keep it warm. */
export function pingLLM(config: LLMConfig = {}): Promise<void> {
  const resolved = resolveLLMConfig(config);
  const url = new URL(resolved.endpoint.replace(/\/$/, '') + '/models');
  const isHttps = url.protocol === 'https:';
  const requester = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = requester.request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname
      },
      (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve());
      }
    );

    req.on('error', (error) => reject(error));
    req.setTimeout(resolved.timeoutMs, () => {
      req.destroy(new Error('LLM ping timed out.'));
    });
    req.end();
  });
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

/** Issue the HTTP request for a non-streaming chat completion. */
function requestChatCompletion(
  config: ResolvedLLMConfig,
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<ChatCompletionResponse> {
  const url = new URL(config.endpoint.replace(/\/$/, '') + '/chat/completions');
  const body = JSON.stringify({
    model: config.model,
    messages,
    temperature: 0,
    stream: false
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body).toString()
  };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const isHttps = url.protocol === 'https:';
  const requestOptions: http.RequestOptions = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    headers
  };

  const requester = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = requester.request(requestOptions, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as ChatCompletionResponse);
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${String(error)}`));
        }
      });
    });

    req.on('error', (error) => reject(error));
    req.setTimeout(config.timeoutMs, () => {
      req.destroy(new Error('LLM request timed out.'));
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('LLM request aborted.'));
        return;
      }
      signal.addEventListener('abort', () => {
        req.destroy(new Error('LLM request aborted.'));
      });
    }
    req.write(body);
    req.end();
  });
}

/** Issue the HTTP request for a streaming chat completion. */
function requestChatCompletionStream(
  config: ResolvedLLMConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const url = new URL(config.endpoint.replace(/\/$/, '') + '/chat/completions');
  const body = JSON.stringify({
    model: config.model,
    messages,
    temperature: 0,
    stream: true
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body).toString()
  };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const isHttps = url.protocol === 'https:';
  const requestOptions: http.RequestOptions = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    headers
  };

  const requester = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    let buffer = '';
    let fullText = '';

    const req = requester.request(requestOptions, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) {
            continue;
          }
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            return;
          }
          try {
            const payload = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
            };
            const delta = payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content ?? '';
            if (delta) {
              fullText += delta;
              onDelta(delta);
            }
          } catch {
            continue;
          }
        }
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        resolve(fullText);
      });
    });

    req.on('error', (error) => reject(error));
    req.setTimeout(config.timeoutMs, () => {
      req.destroy(new Error('LLM request timed out.'));
    });
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('LLM request aborted.'));
        return;
      }
      signal.addEventListener('abort', () => {
        req.destroy(new Error('LLM request aborted.'));
      });
    }
    req.write(body);
    req.end();
  });
}
