import type { ChatCompletionResponse } from '../llm/client';

export function extractJsonPayload(response: ChatCompletionResponse): { files?: unknown } {
  return parseJsonResponse(response) as { files?: unknown };
}

export function extractJsonObject(response: ChatCompletionResponse): Record<string, unknown> {
  const parsed = parseJsonResponse(response);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON is not an object.');
  }
  return parsed as Record<string, unknown>;
}

function parseJsonResponse(response: ChatCompletionResponse): unknown {
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
    throw new Error(`Invalid JSON from LLM: ${String(error)}`);
  }
}
