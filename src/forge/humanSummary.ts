/** Human-readable summary call (separate from structured JSON). */
import type { ChatMessage } from '../llm/client';
import { callChatCompletion } from '../llm/client';
import { getRoutedConfig } from '../llm/routing';
import { mergeChatHistory } from './intent';
import { recordPrompt, recordResponse } from './trace';
import type { ChatHistoryItem } from './types';

/** Produce a concise, user-facing summary after edits. */
export async function generateHumanSummary(
  instruction: string,
  changeSummary: string,
  signal?: AbortSignal,
  history?: ChatHistoryItem[]
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Summarize the completed changes for the user. Keep it concise (3-6 bullets). ' +
        'Mention key files and any follow-up actions. Do not include code blocks.'
    },
    {
      role: 'user',
      content:
        `Instruction: ${instruction}\n\n` +
        `Change summary:\n${changeSummary || '(no summary)'}\n\n` +
        'Return bullets only.'
    }
  ];

  const merged = mergeChatHistory(history, messages);
  recordPrompt('Human summary prompt', merged, true);
  const response = await callChatCompletion(getRoutedConfig('summary'), merged, signal);
  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) {
    return null;
  }
  recordResponse('Human summary response', content);
  return content;
}
