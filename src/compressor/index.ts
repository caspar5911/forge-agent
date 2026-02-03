/** Task compressor: turns instructions into a plan or clarification questions. */
import type { LLMConfig } from '../llm/config';
import type { ChatMessage } from '../llm/client';
import { requestStructuredJson } from '../llm/structured';
import { TASK_PLAN_SCHEMA } from '../forge/schemas';
import { recordPrompt, recordResponse, recordStep } from '../forge/trace';

// Minimal shape for any project context data.
export type ProjectContext = Record<string, unknown>;

// Output can be either clarification questions or a concrete task plan.
export type TaskPlan =
  | { kind: 'clarification'; questions: string[] }
  | { kind: 'plan'; steps: string[] };

/** Convert an instruction into questions or an ordered plan using the local LLM. */
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
  recordPrompt('Task compression prompt', messages, true);

  try {
    const payload = await requestStructuredJson<TaskPlan>(messages, TASK_PLAN_SCHEMA, { config });
    recordResponse('Task compression response', JSON.stringify(payload));
    return payload;
  } catch {
    recordStep('Task compression fallback', 'Using local fallback plan.');
    // If the LLM fails, fall back to a deterministic local plan.
    return compressTaskLocal(trimmed);
  }
}

/** Deterministic fallback when the LLM fails or returns invalid output. */
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

/** Build the LLM prompt for task compression. */
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
