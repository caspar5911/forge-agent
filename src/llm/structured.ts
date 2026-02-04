/**
 * Structured JSON helper.
 *
 * Previous versions of Forge relied on OpenAI's `response_format` (json_schema/json_object).
 * That does *not* exist across all OpenAI-compatible backends (and is not guaranteed for vLLM/Ollama),
 * so we standardize on:
 * 1) prompt for strict JSON
 * 2) parse + repair
 * 3) validate against the provided JSON schema (Ajv)
 * 4) retry with stricter system instructions when needed
 */
import Ajv, { type ValidateFunction } from 'ajv';
import type { ChatCompletionResponse, ChatMessage } from './client';
import { callChatCompletion } from './client';
import type { LLMConfig } from './config';

export type JsonSchema = Record<string, unknown>;

export type StructuredRequestOptions = {
  config?: LLMConfig;
  signal?: AbortSignal;
  maxRetries?: number;
};

const ajv = new Ajv({
  // We compile many small schemas and want actionable errors when the model drifts.
  allErrors: true,
  // Our schemas come from prompts and are intentionally pragmatic, not fully strict JSONSchema drafts.
  strict: false
});

const validatorCache = new WeakMap<object, ValidateFunction>();

/** Request a schema-valid JSON response with retries and a small repair fallback. */
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
      const response = await callChatCompletion(options.config ?? {}, attemptMessages, options.signal);
      const parsed = extractJsonFromResponse(response);
      assertValidSchema(schema, parsed);
      return parsed as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('Structured JSON request failed.');
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

function assertValidSchema(schema: JsonSchema, data: unknown): void {
  const validate = getValidator(schema);
  const ok = validate(data);
  if (ok) {
    return;
  }

  const details = (validate.errors ?? [])
    .slice(0, 6)
    .map((err) => {
      const where = err.instancePath || '(root)';
      return `${where} ${err.message ?? 'is invalid'}`;
    })
    .join('; ');

  throw new Error(`JSON did not match schema: ${details || 'validation failed'}`);
}

function getValidator(schema: JsonSchema): ValidateFunction {
  const cached = validatorCache.get(schema);
  if (cached) {
    return cached;
  }

  // Ajv expects a plain object. Our schemas are already JSON-schema shaped.
  const compiled = ajv.compile(schema);
  validatorCache.set(schema, compiled);
  return compiled;
}

function buildStrictRetryMessages(messages: ChatMessage[], attempt: number): ChatMessage[] {
  const strict =
    attempt === 1
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
