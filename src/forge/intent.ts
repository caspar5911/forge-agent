/** Intent detection and clarification helpers. */
import * as vscode from 'vscode';
import { harvestContext, type ProjectContext } from '../context';
import type { ChatMessage } from '../llm/client';
import { INTENT_SCHEMA, CLARIFICATION_SCHEMA, CLARIFICATION_SUGGEST_SCHEMA, DISAMBIGUATION_SCHEMA } from './schemas';
import { logOutput, logVerbose } from './logging';
import { listWorkspaceFiles } from './workspaceFiles';
import { extractExplicitPaths } from './fileSearch';
import { getForgeSetting } from './settings';
import { requestStructuredJson } from '../llm/structured';
import { recordPrompt, recordResponse } from './trace';
import type { ChatHistoryItem, Intent } from './types';
import type { ForgeUiApi } from '../ui/api';

type DisambiguationOption = { label: string; instruction: string };

let pendingDisambiguation: DisambiguationOption[] | null = null;

/** Read the currently queued disambiguation options, if any. */
export function getPendingDisambiguation(): DisambiguationOption[] | null {
  return pendingDisambiguation;
}

/** Clear any pending disambiguation options. */
export function clearPendingDisambiguation(): void {
  pendingDisambiguation = null;
}

/** Merge recent chat history into a new message list with size limits. */
export function mergeChatHistory(history: ChatHistoryItem[] | undefined, messages: ChatMessage[]): ChatMessage[] {
  if (!history || history.length === 0) {
    return messages;
  }
  const maxMessages = Math.max(0, getForgeSetting<number>('chatHistoryMaxMessages') ?? 8);
  const maxChars = Math.max(0, getForgeSetting<number>('chatHistoryMaxChars') ?? 8000);

  const filtered = history.filter((item) => item && item.content && item.content.trim().length > 0);
  const tail = maxMessages > 0 ? filtered.slice(-maxMessages) : [];

  const trimmed: ChatMessage[] = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const item = tail[i];
    const content = item.content.trim();
    const next = used + content.length;
    if (maxChars > 0 && next > maxChars) {
      continue;
    }
    trimmed.unshift({ role: item.role, content });
    used = next;
  }

  return trimmed.concat(messages);
}

/** Determine whether the instruction is an edit, question, or fix request. */
export async function determineIntent(
  instruction: string,
  output: vscode.OutputChannel,
  panelApi: ForgeUiApi | undefined,
  signal: AbortSignal,
  history?: ChatHistoryItem[]
): Promise<Intent> {
  const useLlm = getForgeSetting<boolean>('intentUseLLM') === true;
  if (!useLlm) {
    return classifyIntent(instruction);
  }

  const messages = buildIntentMessages(instruction);
  recordPrompt('Intent prompt', messages, true);
  try {
    const payload = await requestStructuredJson<Record<string, unknown>>(messages, INTENT_SCHEMA, { signal });
    recordResponse('Intent response', JSON.stringify(payload));
    const intent = String(payload.intent ?? '').toLowerCase();
    if (intent === 'edit' || intent === 'question' || intent === 'fix') {
      if (intent === 'fix' && !isValidationFixRequest(instruction)) {
        return 'edit';
      }
      return intent;
    }
  } catch (error) {
    logVerbose(output, panelApi, `Intent LLM error: ${String(error)}`);
  }

  return classifyIntent(instruction);
}

/** Detect explicit edit requests that should override fix/question intent. */
export function isExplicitEditRequest(instruction: string): boolean {
  const explicitPaths = extractExplicitPaths(instruction);
  if (explicitPaths.length === 0) {
    return false;
  }
  const lowered = instruction.toLowerCase();
  const returnFull = /\breturn (the )?full file content(s)?\b/.test(lowered);
  const hasEditVerb = /\b(edit|update|change|fix|refactor|remove|delete|add|implement|guard|default|modify|adjust|rename)\b/.test(lowered);
  const explicitFileList = /\bedit these files\b|\bupdate these files\b|\bfiles:\s*-/.test(lowered);
  return returnFull || hasEditVerb || explicitFileList;
}

/** Decide whether to continue editing even if validation already passes. */
export function shouldContinueAfterValidationPass(instruction: string): boolean {
  const lowered = instruction.toLowerCase();
  if (isExplicitEditRequest(instruction)) {
    return true;
  }
  const hasEditVerb = /\b(edit|update|change|fix|refactor|remove|delete|add|implement|guard|default|modify|adjust|rename)\b/.test(lowered);
  const returnFull = /\breturn (the )?full file content(s)?\b/.test(lowered);
  return hasEditVerb || returnFull;
}

/** Rule-based fallback intent classifier. */
export function classifyIntent(instruction: string): Intent {
  const trimmed = instruction.trim();
  const lowered = trimmed.toLowerCase();
  if (isCasualChatPrompt(lowered)) {
    return 'question';
  }
  if (/(resolve|fix|repair).*(error|errors|failing|failure|tests|test|build|lint|typecheck)/.test(lowered)) {
    return 'fix';
  }
  if (/(add|update|change|fix|refactor|remove|delete|create|implement|comment|comments|document)\b/.test(lowered)) {
    return 'edit';
  }
  if (trimmed.endsWith('?')) {
    return 'question';
  }
  if (/(^|\s)(how|what|why|where|when|which|who)\b/.test(lowered)) {
    return 'question';
  }
  if (/^(show|list|count)\b/.test(lowered)) {
    return 'question';
  }
  if (/^(check|inspect|review|summarize|summary|describe)\b/.test(lowered)) {
    return 'question';
  }
  if (lowered.includes('in points') || lowered.includes('point form')) {
    return 'question';
  }
  return 'edit';
}

/** Detect casual chat prompts that should be treated as questions. */
export function isCasualChatPrompt(lowered: string): boolean {
  if (lowered.length === 0) {
    return true;
  }
  if (lowered.length <= 12 && !/\b(add|edit|fix|update|create|remove|delete)\b/.test(lowered)) {
    return true;
  }
  if (/\b(my name is|my friend|i am|i'm|hello|hi|hey|thanks|thank you)\b/.test(lowered)) {
    return true;
  }
  if (!/[\/\\]/.test(lowered) && !/\b(file|files|component|module|class|function|code)\b/.test(lowered)) {
    if (!/\b(add|edit|fix|update|create|remove|delete|implement|refactor|rename)\b/.test(lowered)) {
      return true;
    }
  }
  return false;
}

/** Detect whether a "fix" request is about validation/test/build failures. */
function isValidationFixRequest(instruction: string): boolean {
  return /\b(error|errors|failing|failure|test|tests|build|lint|typecheck|compile|ci|pipeline)\b/i.test(
    instruction
  );
}

/** Detect questions that ask to show file contents. */
export function isFileReadQuestion(lowered: string): boolean {
  if (/\b(show|open|read|view|display)\b/.test(lowered)) {
    return /\bfile|files|content\b/.test(lowered) || /[a-z0-9_-]+\.(ts|tsx|js|jsx|json|md|css|html)\b/.test(lowered);
  }
  return /\bwhat is in\b/.test(lowered);
}

/** Build default assumptions to proceed when clarification is required. */
export function buildDefaultAssumptions(
  clarification: string[],
  activeRelativePath: string | null
): string[] {
  const assumptions: string[] = [];
  const joined = clarification.join(' ').toLowerCase();
  if (joined.includes('file')) {
    if (activeRelativePath) {
      assumptions.push(`Apply changes to the active file (${activeRelativePath}).`);
    } else {
      assumptions.push('Apply changes to the most relevant files based on the prompt.');
    }
  }

  if (joined.includes('style')) {
    assumptions.push('Follow the existing code style in the file.');
  }

  if (joined.includes('comments')) {
    assumptions.push('Add concise comments only where logic is non-obvious.');
  }

  if (assumptions.length === 0) {
    assumptions.push('Proceed with minimal, safe changes based on the prompt.');
  }

  return assumptions;
}

/** Ask the LLM for clarification questions when the instruction is ambiguous. */
export async function maybeClarifyInstruction(
  instruction: string,
  rootPath: string,
  output: vscode.OutputChannel,
  panelApi: ForgeUiApi | undefined,
  signal: AbortSignal,
  history?: ChatHistoryItem[]
): Promise<string[] | null> {
  const maxQuestions = Math.max(1, getForgeSetting<number>('clarifyMaxQuestions') ?? 6);
  const context = harvestContext();
  const filesList = context.files && context.files.length > 0
    ? context.files
    : listWorkspaceFiles(rootPath, 4, 500);
  const messages = mergeChatHistory(
    history,
    buildClarificationMessages(instruction, context, filesList, maxQuestions)
  );
  recordPrompt('Clarification prompt', messages, true);
  try {
    const payload = await requestStructuredJson<Record<string, unknown>>(messages, CLARIFICATION_SCHEMA, { signal });
    recordResponse('Clarification response', JSON.stringify(payload));
    const kind = String(payload.kind ?? '').toLowerCase();
    if (kind !== 'clarification') {
      return null;
    }
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    return questions
      .map((item) => String(item))
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, maxQuestions);
  } catch (error) {
    logVerbose(output, panelApi, `Clarification check error: ${String(error)}`);
    return null;
  }
}

type ClarificationSuggestion = {
  answers: string[];
  plan: string[];
};

/** Generate best-guess answers and a draft plan for clarification prompts. */
export async function maybeSuggestClarificationAnswers(
  instruction: string,
  questions: string[],
  rootPath: string,
  output: vscode.OutputChannel,
  panelApi: ForgeUiApi | undefined,
  signal: AbortSignal,
  history?: ChatHistoryItem[]
): Promise<ClarificationSuggestion | null> {
  const context = harvestContext();
  const filesList = context.files && context.files.length > 0
    ? context.files
    : listWorkspaceFiles(rootPath, 4, 300);
  const messages = mergeChatHistory(
    history,
    buildClarificationSuggestionMessages(instruction, questions, context, filesList)
  );
  recordPrompt('Clarification suggestions prompt', messages, true);
  try {
    const payload = await requestStructuredJson<Record<string, unknown>>(
      messages,
      CLARIFICATION_SUGGEST_SCHEMA,
      { signal }
    );
    recordResponse('Clarification suggestions response', JSON.stringify(payload));
    const answers = Array.isArray(payload.answers) ? payload.answers.map((item) => String(item)).filter(Boolean) : [];
    const plan = Array.isArray(payload.plan) ? payload.plan.map((item) => String(item)).filter(Boolean) : [];
    return { answers, plan };
  } catch (error) {
    logVerbose(output, panelApi, `Clarification suggestion error: ${String(error)}`);
    return null;
  }
}

/** Build the prompt used to request clarification questions. */
function buildClarificationMessages(
  instruction: string,
  context: ProjectContext,
  filesList: string[],
  maxQuestions: number
): ChatMessage[] {
  const preview = filesList.slice(0, 120).join('\n');
  const truncated = filesList.length > 120 ? '\n...(truncated)' : '';
  return [
    {
      role: 'system',
      content:
        'You are checking whether a coding instruction is ambiguous. ' +
        'If it is clear, return {"kind":"proceed"}. ' +
        `If it is ambiguous, return {"kind":"clarification","questions":[...]} with up to ${maxQuestions} questions. ` +
        'Err on the side of asking questions if any key requirements are missing (files, stack, scope, constraints, acceptance). ' +
        'Ask as many questions as needed to fully specify requirements. ' +
        'If the instruction is to create a website or UI, ask about stack, layout/sections, content, style/tone, and assets. ' +
        'Return ONLY valid JSON.'
    },
    {
      role: 'user',
      content:
        `Instruction: ${instruction}\n\n` +
        'Project context:\n' +
        `${JSON.stringify(
          {
            workspaceRoot: context.workspaceRoot,
            activeEditorFile: context.activeEditorFile,
            packageManager: context.packageManager,
            frontendFramework: context.frontendFramework,
            backendFramework: context.backendFramework
          },
          null,
          2
        )}\n\n` +
        'Files (partial list):\n' +
        preview +
        truncated
    }
  ];
}

function buildClarificationSuggestionMessages(
  instruction: string,
  questions: string[],
  context: ProjectContext,
  filesList: string[]
): ChatMessage[] {
  const preview = filesList.slice(0, 120).join('\n');
  const truncated = filesList.length > 120 ? '\n...(truncated)' : '';
  return [
    {
      role: 'system',
      content:
        'You are proposing best-guess answers to clarification questions for a coding task. ' +
        'Return ONLY valid JSON in the form {"answers":[...],"plan":[...]}. ' +
        'Answers must align with the questions in order. ' +
        'If information is missing, make reasonable defaults and label them as assumptions.'
    },
    {
      role: 'user',
      content:
        `Instruction: ${instruction}\n\n` +
        'Clarification questions:\n' +
        questions.map((item) => `- ${item}`).join('\n') +
        '\n\nProject context:\n' +
        `${JSON.stringify(
          {
            workspaceRoot: context.workspaceRoot,
            activeEditorFile: context.activeEditorFile,
            packageManager: context.packageManager,
            frontendFramework: context.frontendFramework,
            backendFramework: context.backendFramework
          },
          null,
          2
        )}\n\n` +
        'Files (partial list):\n' +
        preview +
        truncated
    }
  ];
}

/** Ask the LLM to propose multiple disambiguation options. */
export async function maybePickDisambiguation(
  instruction: string,
  rootPath: string,
  output: vscode.OutputChannel,
  panelApi: ForgeUiApi | undefined,
  signal: AbortSignal
): Promise<string | null> {
  const context = harvestContext();
  const filesList = context.files && context.files.length > 0
    ? context.files
    : listWorkspaceFiles(rootPath, 3, 200);
  const messages = buildDisambiguationOptionsMessages(instruction, context, filesList);
  recordPrompt('Disambiguation prompt', messages, true);
  try {
    const payload = await requestStructuredJson<Record<string, unknown>>(
      messages,
      DISAMBIGUATION_SCHEMA,
      { signal }
    );
    recordResponse('Disambiguation response', JSON.stringify(payload));
    const options = Array.isArray(payload.options) ? payload.options : [];
    const mapped = options
      .map((option) => {
        if (option && typeof option === 'object') {
          const obj = option as { label?: unknown; instruction?: unknown };
          return {
            label: String(obj.label ?? ''),
            detail: typeof obj.instruction === 'string' ? obj.instruction : undefined
          };
        }
        return { label: String(option), detail: undefined };
      })
      .filter((option) => option.label.length > 0)
      .slice(0, 4);
    if (mapped.length === 0) {
      return null;
    }
    const numbered = mapped.map((item, index) => ({
      label: `${index + 1}. ${item.label}`,
      instruction: item.detail ?? item.label
    }));
    pendingDisambiguation = numbered.map((item) => ({
      label: item.label,
      instruction: item.instruction
    }));
    logOutput(output, panelApi, 'Pick one option by replying with its number:');
    numbered.forEach((item) => logOutput(output, panelApi, item.label));
    return null;
  } catch (error) {
    logVerbose(output, panelApi, `Disambiguation error: ${String(error)}`);
    return null;
  }
}

/** Parse a numeric disambiguation choice from user input. */
export function parseDisambiguationPick(input: string, max: number): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const index = Number(trimmed);
  if (Number.isNaN(index) || index < 1 || index > max) {
    return null;
  }
  return index - 1;
}

/** Build the prompt used to generate disambiguation options. */
function buildDisambiguationOptionsMessages(
  instruction: string,
  context: ProjectContext,
  filesList: string[]
): ChatMessage[] {
  const preview = filesList.slice(0, 80).join('\n');
  const truncated = filesList.length > 80 ? '\n...(truncated)' : '';
  return [
    {
      role: 'system',
      content:
        'Propose 2-4 possible interpretations of the instruction as short options. ' +
        'Return ONLY valid JSON: {"options":[{"label":"...","instruction":"..."}]}.'
    },
    {
      role: 'user',
      content:
        `Instruction: ${instruction}\n\n` +
        'Project context:\n' +
        `${JSON.stringify(
          {
            workspaceRoot: context.workspaceRoot,
            activeEditorFile: context.activeEditorFile,
            packageManager: context.packageManager,
            frontendFramework: context.frontendFramework,
            backendFramework: context.backendFramework
          },
          null,
          2
        )}\n\n` +
        'Files (partial list):\n' +
        preview +
        truncated
    }
  ];
}

/** Build the prompt for intent classification. */
function buildIntentMessages(instruction: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'Classify the user intent into one of: edit, question, fix. ' +
        'Return ONLY valid JSON in the form {"intent":"edit|question|fix","confidence":0-1}.'
    },
    {
      role: 'user',
      content: instruction
    }
  ];
}
