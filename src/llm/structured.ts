/** Structured JSON helper with schema-first decoding and repair fallback. */
import type { ChatCompletionResponse, ChatMessage, ResponseFormat } from './client';
import { callChatCompletion, callChatCompletionWithOptions } from './client';
import type { LLMConfig } from './config';

export type JsonSchema = Record<string, unknown>;

type SchemaSupport = 'unknown' | 'json_schema' | 'json_object' | 'none';

let schemaSupport: SchemaSupport = 'unknown';

export type StructuredRequestOptions = {
  config?: LLMConfig;
  signal?: AbortSignal;
  maxRetries?: number;
};

export async function requestStructuredJson<T>(
  messages: ChatMessage[],
  schema: JsonSchema,
  options: StructuredRequestOptions = {}
): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptMessages = attempt === 0 ? messages : buildStrictRetryMessages(messages, attempt);
    try {
      const response = await callStructuredCompletion(attemptMessages, schema, options);
      const parsed = extractJsonFromResponse(response);
      return parsed as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('Structured JSON request failed.');
}

async function callStructuredCompletion(
  messages: ChatMessage[],
  schema: JsonSchema,
  options: StructuredRequestOptions
): Promise<ChatCompletionResponse> {
  const config = options.config ?? {};
  if (schemaSupport === 'json_schema') {
    return callChatCompletionWithOptions(config, messages, { responseFormat: buildJsonSchemaFormat(schema) }, options.signal);
  }
  if (schemaSupport === 'json_object') {
    return callChatCompletionWithOptions(config, messages, { responseFormat: { type: 'json_object' } }, options.signal);
  }
  if (schemaSupport === 'none') {
    return callChatCompletion(config, messages, options.signal);
  }

  try {
    const response = await callChatCompletionWithOptions(
      config,
      messages,
      { responseFormat: buildJsonSchemaFormat(schema) },
      options.signal
    );
    schemaSupport = 'json_schema';
    return response;
  } catch (error) {
    if (isSchemaFormatUnsupported(error)) {
      try {
        const response = await callChatCompletionWithOptions(
          config,
          messages,
          { responseFormat: { type: 'json_object' } },
          options.signal
        );
        schemaSupport = 'json_object';
        return response;
      } catch (fallbackError) {
        if (isSchemaFormatUnsupported(fallbackError)) {
          schemaSupport = 'none';
          return callChatCompletion(config, messages, options.signal);
        }
        throw fallbackError;
      }
    }
    throw error;
  }
}

function buildJsonSchemaFormat(schema: JsonSchema): ResponseFormat {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'StructuredResponse',
      schema,
      strict: true
    }
  };
}

function extractJsonFromResponse(response: ChatCompletionResponse): unknown {
  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) {
    const errorMessage = response.error?.message ?? 'No content returned by LLM.';
    throw new Error(errorMessage);
  }

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : content;

  try {
    return JSON.parse(raw);
  } catch (error) {
    const repaired = repairJson(raw);
    if (repaired !== raw) {
      try {
        return JSON.parse(repaired);
      } catch {
        // fall through
      }
    }
    throw new Error(`Invalid JSON from LLM: ${String(error)}`);
  }
}

function buildStrictRetryMessages(messages: ChatMessage[], attempt: number): ChatMessage[] {
  const strict = attempt === 1
    ? 'Return ONLY valid JSON. It must be parseable by JSON.parse. No code fences, no extra text.'
    : attempt === 2
      ? 'Return ONLY valid minified JSON. Escape all newlines as \\n and quotes inside strings as \\".'
      : 'Return ONLY minified JSON. No whitespace outside strings. If unsure, return {}.';
  return [{ role: 'system', content: strict }, ...messages];
}

function repairJson(input: string): string {
  let text = input;
  text = text.replace(/^[^\{]*\{/s, '{').replace(/\}[^\}]*$/s, '}');
  text = text.replace(/,\s*([}\]])/g, '$1');
  text = escapeStringNewlines(text);
  return text;
}

function escapeStringNewlines(text: string): string {
  let result = '';
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (!inString) {
      if (char === '"') {
        inString = true;
      }
      result += char;
      continue;
    }

    if (escapeNext) {
      escapeNext = false;
      result += char;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      result += char;
      continue;
    }

    if (char === '"') {
      const next = peekNextNonWhitespace(text, i + 1);
      if (next && !',}]'.includes(next) && next !== ':') {
        result += '\\"';
        continue;
      }
      inString = false;
      result += char;
      continue;
    }

    if (char === '\n') {
      result += '\\n';
      continue;
    }
    if (char === '\r') {
      result += '\\r';
      continue;
    }
    if (char === '\t') {
      result += '\\t';
      continue;
    }

    result += char;
  }

  return result;
}

function peekNextNonWhitespace(text: string, start: number): string | null {
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (!/\s/.test(char)) {
      return char;
    }
  }
  return null;
}

function isSchemaFormatUnsupported(error: unknown): boolean {
  const message = String(error ?? '').toLowerCase();
  return (
    message.includes('response_format') ||
    message.includes('json_schema') ||
    message.includes('json schema') ||
    message.includes('unsupported') ||
    message.includes('unrecognized') ||
    message.includes('unknown field')
  );
}
