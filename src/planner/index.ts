/** Planner: chooses the next safe tool call from a task plan. */
// Node path utilities for safe relative path handling.
import * as path from 'path';
import type { LLMConfig } from '../llm/config';
import type { ChatMessage } from '../llm/client';
import { requestStructuredJson } from '../llm/structured';
import { TOOL_CALL_SCHEMA } from '../forge/schemas';
import { recordPrompt, recordResponse, recordStep } from '../forge/trace';
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

/** Pick the next single safe tool call based on the plan step using the local LLM. */
export async function nextToolCall(
  input: PlannerInput,
  config: LLMConfig = {},
  memoryContext?: string
): Promise<ToolCall> {
  const messages = buildMessages(input, memoryContext);
  recordPrompt('Planner prompt', messages, true);

  try {
    const payload = await requestStructuredJson<ToolCall>(messages, TOOL_CALL_SCHEMA, { config });
    recordResponse('Planner response', JSON.stringify(payload));
    return payload;
  } catch {
    recordStep('Planner fallback', 'Using local planner fallback.');
    // Fall back to deterministic planning if the LLM fails.
    return nextToolCallLocal(input);
  }
}

/** Deterministic fallback planner logic. */
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

/** Try to resolve a file mentioned in the plan step. */
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

/** Convert an absolute file path to a workspace-relative path when possible. */
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

/** Pick a validation command based on the step and package.json scripts. */
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

/** Build the LLM prompt for selecting the next tool call. */
function buildMessages(input: PlannerInput, memoryContext?: string): ChatMessage[] {
  const { plan, context } = input;
  const previousResults = input.previousResults ?? [];
  const stepIndex =
    plan.kind === 'plan' && plan.steps.length > 0
      ? Math.min(previousResults.length, plan.steps.length - 1)
      : 0;
  const step = plan.kind === 'plan' && plan.steps.length > 0 ? plan.steps[stepIndex] : null;

  const memoryBlock = memoryContext ? `\n\nProject memory:\n${memoryContext}` : '';

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
        `CurrentStep: ${step ?? 'N/A'}\n` +
        memoryBlock
    }
  ];
}
