import type { LLMConfig } from '../llm/config';
import type { ChatCompletionResponse, ChatMessage } from '../llm/client';
import { callChatCompletion } from '../llm/client';

// Minimal shape for any project context data.
export type ProjectContext = Record<string, unknown>;

// Output can be either clarification questions or a concrete task plan.
export type TaskPlan =
  | { kind: 'clarification'; questions: string[] }
  | { kind: 'plan'; steps: string[] };

// Convert a short instruction into either questions or an ordered plan using the local LLM.
export async function compressTask(
  instruction: string,
  context: ProjectContext,
  config: LLMConfig = {}
): Promise<TaskPlan> {
  const trimmed = instruction.trim();
  if (!trimmed) {
    return {
      kind: 'clarification',
      questions: [
        'What should be changed or created?',
        'Which part of the project does this apply to?',
        'What is the expected outcome?'
      ]
    };
  }

  const messages = buildMessages(trimmed, context);

  try {
    const response = await callChatCompletion(config, messages);
    const plan = parseTaskPlan(response);
    return plan;
  } catch {
    // If the LLM fails, fall back to a deterministic local plan.
    return compressTaskLocal(trimmed);
  }
}

// Deterministic fallback when the LLM fails or returns invalid output.
export function compressTaskLocal(instruction: string): TaskPlan {
  const trimmed = instruction.trim();
  if (!trimmed) {
    return {
      kind: 'clarification',
      questions: [
        'What should be changed or created?',
        'Which part of the project does this apply to?',
        'What is the expected outcome?'
      ]
    };
  }

  const tokens = trimmed.toLowerCase().match(/[a-z0-9._/\\-]+/g) ?? [];
  const wordCount = tokens.length;
  const hasQuoted = /["'`].+["'`]/.test(trimmed);
  const hasPathLike = tokens.some((token) => token.includes('/') || token.includes('\\') || token.includes('.'));
  const hasVaguePronoun = /\b(it|this|that|these|those|them|something|stuff|anything|whatever)\b/i.test(trimmed);

  if (wordCount < 2 || (hasVaguePronoun && !hasQuoted && !hasPathLike)) {
    return {
      kind: 'clarification',
      questions: [
        'What exactly should be changed or created?',
        'Where in the project should this apply?',
        'What does success look like?'
      ]
    };
  }

  const segments = trimmed
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/g, '')
    .split(/\b(?:and then|then|after that|afterwards|also|and)\b|[.;]/i)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const steps: string[] = [];
  steps.push('Review the provided ProjectContext to understand the current state.');

  if (segments.length <= 1) {
    steps.push(`Carry out the request: ${trimmed}.`);
  } else {
    for (const segment of segments) {
      const sentence = segment.endsWith('.') ? segment : `${segment}.`;
      steps.push(sentence.charAt(0).toUpperCase() + sentence.slice(1));
    }
  }

  steps.push('Verify the result matches the instruction.');

  return { kind: 'plan', steps };
}

function buildMessages(instruction: string, context: ProjectContext): ChatMessage[] {
  const contextJson = JSON.stringify(context, null, 2);

  return [
    {
      role: 'system',
      content:
        'You are a task compressor. Return ONLY valid JSON with one of these shapes: ' +
        '{"kind":"clarification","questions":["..."]} or {"kind":"plan","steps":["..."]}. ' +
        'Do not include code fences, comments, or extra text. Ask for clarification if the instruction is ambiguous.'
    },
    {
      role: 'user',
      content: `Instruction:\n${instruction}\n\nProjectContext:\n${contextJson}`
    }
  ];
}

function parseTaskPlan(response: ChatCompletionResponse): TaskPlan {
  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) {
    const errorMessage = response.error?.message ?? 'No content returned by LLM.';
    throw new Error(errorMessage);
  }

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON from LLM: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('LLM output is not a JSON object.');
  }

  const plan = parsed as { kind?: unknown; steps?: unknown; questions?: unknown };
  if (plan.kind === 'clarification') {
    if (!Array.isArray(plan.questions) || plan.questions.length === 0) {
      throw new Error('Clarification must include a non-empty questions array.');
    }
    if (!plan.questions.every((q) => typeof q === 'string' && q.trim().length > 0)) {
      throw new Error('Clarification questions must be non-empty strings.');
    }
    return { kind: 'clarification', questions: plan.questions };
  }

  if (plan.kind === 'plan') {
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      throw new Error('Plan must include a non-empty steps array.');
    }
    if (!plan.steps.every((s) => typeof s === 'string' && s.trim().length > 0)) {
      throw new Error('Plan steps must be non-empty strings.');
    }
    return { kind: 'plan', steps: plan.steps };
  }

  throw new Error('LLM output has an invalid kind.');
}
