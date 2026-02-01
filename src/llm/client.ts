import * as http from 'http';
import * as https from 'https';
import type { LLMConfig, ResolvedLLMConfig } from './config';
import { resolveLLMConfig } from './config';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

export async function callChatCompletion(
  config: LLMConfig,
  messages: ChatMessage[]
): Promise<ChatCompletionResponse> {
  const resolved = resolveLLMConfig(config);
  return requestChatCompletion(resolved, messages);
}

function requestChatCompletion(
  config: ResolvedLLMConfig,
  messages: ChatMessage[]
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
    req.write(body);
    req.end();
  });
}
