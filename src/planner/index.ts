// Node path utilities for safe relative path handling.
import * as path from 'path';
import type { LLMConfig } from '../llm/config';
import type { ChatCompletionResponse, ChatMessage } from '../llm/client';
import { callChatCompletion } from '../llm/client';
// Task plan type from the compressor phase.
import type { TaskPlan } from '../compressor/index';

// Minimal project context shape for the planner.
export type ProjectContext = {
  workspaceRoot?: string | null;
  activeEditorFile?: string | null;
  files?: string[] | null;
  packageJson?: unknown;
  packageManager?: string | null;
  frontendFramework?: string | null;
  backendFramework?: string | null;
};

// Tool results from previous planner steps.
export type ToolResult = {
  tool: string;
  input?: unknown;
  output?: unknown;
};

// Allowed tool calls for this phase.
export type ToolCall =
  | { tool: 'read_file'; path: string }
  | { tool: 'request_diff' }
  | { tool: 'run_validation_command'; command: string };

// Planner inputs: current plan, context, and prior tool outputs.
export type PlannerInput = {
  plan: TaskPlan;
  context: ProjectContext;
  previousResults?: ToolResult[];
};

// Pick the next single safe tool call based on the plan step using the local LLM.
export async function nextToolCall(
  input: PlannerInput,
  config: LLMConfig = {}
): Promise<ToolCall> {
  const messages = buildMessages(input);

  try {
    const response = await callChatCompletion(config, messages);
    return parseToolCall(response);
  } catch {
    // Fall back to deterministic planning if the LLM fails.
    return nextToolCallLocal(input);
  }
}

// Deterministic fallback planner logic.
export function nextToolCallLocal(input: PlannerInput): ToolCall {
  const previousResults = input.previousResults ?? [];
  const { plan, context } = input;

  // If the plan needs clarification or has no steps, request a diff for grounding.
  if (plan.kind === 'clarification' || !plan.steps.length) {
    return { tool: 'request_diff' };
  }

  // Select the step based on how many tool calls have already run (no skipping).
  const stepIndex = Math.min(previousResults.length, plan.steps.length - 1);
  const step = plan.steps[stepIndex];
  const stepLower = step.toLowerCase();

  // If the step asks for validation, pick a known validation command.
  const validationCommand = pickValidationCommand(stepLower, context);
  if (validationCommand) {
    return { tool: 'run_validation_command', command: validationCommand };
  }

  // If the step mentions a file, read that file.
  const fileFromStep = pickFileFromStep(step, context);
  if (fileFromStep) {
    return { tool: 'read_file', path: fileFromStep };
  }

  // If the step suggests reading/reviewing, read the active editor file.
  if (stepLower.includes('read') || stepLower.includes('open') || stepLower.includes('review')) {
    const active = toRelativeIfPossible(context.activeEditorFile ?? null, context.workspaceRoot ?? null);
    if (active) {
      return { tool: 'read_file', path: active };
    }
  }

  // If the step is about reviewing changes, request a diff.
  if (stepLower.includes('diff') || stepLower.includes('change') || stepLower.includes('verify')) {
    return { tool: 'request_diff' };
  }

  // If we cannot determine a safe action, request a diff (safe default).
  return { tool: 'request_diff' };
}

// Try to resolve a file mentioned in the plan step.
function pickFileFromStep(step: string, context: ProjectContext): string | null {
  const files = (context.files ?? []).map((file) => file.replace(/\\/g, '/'));
  const tokens = step.match(/[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+/g) ?? [];
  const normalizedTokens = tokens.map((token) => token.replace(/\\/g, '/'));

  // Handle explicit package.json mentions.
  if (step.toLowerCase().includes('package.json') && !normalizedTokens.includes('package.json')) {
    normalizedTokens.push('package.json');
  }

  let bestMatch: string | null = null;
  // Pick the closest matching file in the known file list.
  for (const token of normalizedTokens) {
    const tokenLower = token.toLowerCase();
    for (const file of files) {
      const fileLower = file.toLowerCase();
      if (fileLower === tokenLower || fileLower.endsWith(`/${tokenLower}`)) {
        if (!bestMatch || file.length < bestMatch.length) {
          bestMatch = file;
        }
      }
    }
  }

  // If a match was found, return it.
  if (bestMatch) {
    return bestMatch;
  }

  return null;
}

// Convert an absolute file path to a workspace-relative path when possible.
function toRelativeIfPossible(filePath: string | null, rootPath: string | null): string | null {
  if (!filePath) {
    return null;
  }
  if (!rootPath) {
    return filePath;
  }
  const relative = path.relative(rootPath, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return filePath;
  }
  return relative;
}

// Pick a validation command based on the step and package.json scripts.
function pickValidationCommand(stepLower: string, context: ProjectContext): string | null {
  const pkg = context.packageJson;
  if (!pkg || typeof pkg !== 'object') {
    return null;
  }
  const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};

  const wantsTest = stepLower.includes('test');
  const wantsLint = stepLower.includes('lint');
  const wantsBuild = stepLower.includes('build');
  const wantsValidate = stepLower.includes('validate') || stepLower.includes('check');

  let scriptName: string | null = null;
  if (wantsTest && scripts.test) {
    scriptName = 'test';
  } else if (wantsLint && scripts.lint) {
    scriptName = 'lint';
  } else if (wantsBuild && scripts.build) {
    scriptName = 'build';
  } else if (wantsValidate) {
    if (scripts.test) {
      scriptName = 'test';
    } else if (scripts.lint) {
      scriptName = 'lint';
    } else if (scripts.build) {
      scriptName = 'build';
    }
  }

  if (!scriptName) {
    return null;
  }

  const pm = context.packageManager ?? 'npm';
  if (pm === 'yarn') {
    return `yarn ${scriptName}`;
  }
  if (pm === 'pnpm') {
    return `pnpm ${scriptName}`;
  }
  if (pm === 'bun') {
    return `bun run ${scriptName}`;
  }
  return `npm run ${scriptName}`;
}

function buildMessages(input: PlannerInput): ChatMessage[] {
  const { plan, context } = input;
  const previousResults = input.previousResults ?? [];
  const stepIndex =
    plan.kind === 'plan' && plan.steps.length > 0
      ? Math.min(previousResults.length, plan.steps.length - 1)
      : 0;
  const step = plan.kind === 'plan' && plan.steps.length > 0 ? plan.steps[stepIndex] : null;

  return [
    {
      role: 'system',
      content:
        'You are a planner. Return ONLY valid JSON with one of these shapes: ' +
        '{"tool":"read_file","path":"..."} or {"tool":"request_diff"} or {"tool":"run_validation_command","command":"..."}. ' +
        'Do not include code fences, comments, or extra text. Choose the next single safe action.'
    },
    {
      role: 'user',
      content:
        `TaskPlan:\n${JSON.stringify(plan, null, 2)}\n\n` +
        `ProjectContext:\n${JSON.stringify(context, null, 2)}\n\n` +
        `PreviousResults:\n${JSON.stringify(previousResults, null, 2)}\n\n` +
        `CurrentStepIndex: ${stepIndex}\n` +
        `CurrentStep: ${step ?? 'N/A'}\n`
    }
  ];
}

function parseToolCall(response: ChatCompletionResponse): ToolCall {
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

  const toolCall = parsed as { tool?: unknown; path?: unknown; command?: unknown };
  if (toolCall.tool === 'read_file') {
    if (typeof toolCall.path !== 'string' || toolCall.path.trim().length === 0) {
      throw new Error('read_file requires a non-empty path.');
    }
    return { tool: 'read_file', path: toolCall.path };
  }

  if (toolCall.tool === 'request_diff') {
    return { tool: 'request_diff' };
  }

  if (toolCall.tool === 'run_validation_command') {
    if (typeof toolCall.command !== 'string' || toolCall.command.trim().length === 0) {
      throw new Error('run_validation_command requires a non-empty command.');
    }
    return { tool: 'run_validation_command', command: toolCall.command };
  }

  throw new Error('LLM output has an invalid tool.');
}
