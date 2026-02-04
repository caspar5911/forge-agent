/** Token budget enforcement for chat messages (approximate). */
import type { ChatMessage } from './client';

const DEFAULT_TOKEN_RATIO = 4; // rough chars per token
const MESSAGE_OVERHEAD = 6;

export type BudgetResult = {
  messages: ChatMessage[];
  trimmed: boolean;
  estimatedTokens: number;
};

export function trimMessagesToTokenBudget(
  messages: ChatMessage[],
  maxTokens: number,
  ratio: number = DEFAULT_TOKEN_RATIO
): BudgetResult {
  const budget = Math.max(200, Math.floor(maxTokens * 0.9));
  const system = messages.filter((msg) => msg.role === 'system');
  const nonSystem = messages.filter((msg) => msg.role !== 'system');

  const systemBudget = Math.min(estimateMessagesTokens(system, ratio), Math.floor(budget * 0.35));
  const trimmedSystem = trimMessagesToFit(system, systemBudget, ratio);
  const remaining = Math.max(0, budget - estimateMessagesTokens(trimmedSystem, ratio));
  const trimmedNonSystem = trimMessagesFromEnd(nonSystem, remaining, ratio);

  const combined = [...trimmedSystem, ...trimmedNonSystem];
  const estimatedTokens = estimateMessagesTokens(combined, ratio);
  const trimmed = combined.length !== messages.length || estimatedTokens > budget;
  return { messages: combined, trimmed, estimatedTokens };
}

export function estimateMessagesTokens(messages: ChatMessage[], ratio: number = DEFAULT_TOKEN_RATIO): number {
  return messages.reduce((total, msg) => total + estimateMessageTokens(msg, ratio), 0);
}

export function estimateMessageTokens(message: ChatMessage, ratio: number = DEFAULT_TOKEN_RATIO): number {
  return Math.ceil(message.content.length / ratio) + MESSAGE_OVERHEAD;
}

function trimMessagesToFit(
  messages: ChatMessage[],
  budget: number,
  ratio: number
): ChatMessage[] {
  if (budget <= 0) {
    return [];
  }
  const result: ChatMessage[] = [];
  let used = 0;
  for (const msg of messages) {
    const tokens = estimateMessageTokens(msg, ratio);
    if (used + tokens <= budget) {
      result.push(msg);
      used += tokens;
      continue;
    }
    const remaining = budget - used;
    if (remaining <= 0) {
      break;
    }
    result.push(trimMessageContent(msg, remaining, ratio));
    used = budget;
    break;
  }
  return result;
}

function trimMessagesFromEnd(
  messages: ChatMessage[],
  budget: number,
  ratio: number
): ChatMessage[] {
  if (budget <= 0) {
    return [];
  }
  const result: ChatMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const tokens = estimateMessageTokens(msg, ratio);
    if (used + tokens <= budget) {
      result.unshift(msg);
      used += tokens;
      continue;
    }
    const remaining = budget - used;
    if (remaining <= 0) {
      break;
    }
    result.unshift(trimMessageContent(msg, remaining, ratio));
    used = budget;
    break;
  }
  return result;
}

function trimMessageContent(message: ChatMessage, availableTokens: number, ratio: number): ChatMessage {
  const maxChars = Math.max(32, Math.floor(availableTokens * ratio));
  if (message.content.length <= maxChars) {
    return message;
  }
  return {
    ...message,
    content: `${message.content.slice(0, maxChars)}\n... (trimmed)`
  };
}

export function parseTokenLimitFromError(body: string): number | null {
  const match = body.match(/maximum context length is\s+(\d+)/i);
  if (match) {
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}
