/** Helper utilities for the Forge runtime orchestration. */
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { harvestContext } from '../context';
import { compressTask } from '../compressor';
import { getDiff, isGitRepo } from '../git';
import { getRoutedConfig } from '../llm/routing';
import { logOutput } from '../forge/logging';
import { recordStep } from '../forge/trace';
import { nextToolCall } from '../planner';
import { runCommand } from '../validation';
import type { ForgeUiApi } from '../ui/api';
import type { FileUpdate } from '../forge/types';

/** Format a clarification follow-up by pairing questions with user answers. */
export function formatClarificationFollowup(
  originalInstruction: string,
  questions: string[],
  answers: string
): string {
  const cleanedAnswers = answers
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.toLowerCase() !== 'copy')
    .join('\n');
  const trimmedAnswers = cleanedAnswers.trim();
  const questionBlock = questions.map((item) => `- ${item}`).join('\n');
  return (
    `${originalInstruction}\n\nClarification questions:\n${questionBlock}\n\n` +
    `Clarification answers:\n${trimmedAnswers.length > 0 ? trimmedAnswers : '(no answer provided)'}`
  );
}

/** Format proposed clarification answers + plan into a single instruction payload. */
export function formatClarificationProposal(
  originalInstruction: string,
  questions: string[],
  proposedAnswers: string[],
  proposedPlan: string[]
): string {
  const questionBlock = questions.map((item) => `- ${item}`).join('\n');
  const answerBlock = proposedAnswers.length > 0
    ? proposedAnswers.map((item) => `- ${item}`).join('\n')
    : '- (no proposed answers)';
  const planBlock = proposedPlan.length > 0
    ? proposedPlan.map((item) => `- ${item}`).join('\n')
    : '- (no plan)';
  return (
    `${originalInstruction}\n\nClarification questions:\n${questionBlock}\n\n` +
    `Proposed answers:\n${answerBlock}\n\nProposed plan:\n${planBlock}`
  );
}

/** Interpret user responses for clarification proposal control flow. */
export function parseClarificationDecision(input: string): 'accept' | 'reject' | 'answer' {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    return 'answer';
  }
  if (/^(accept|yes|y|ok|okay|proceed|continue|run)$/.test(trimmed)) {
    return 'accept';
  }
  if (/^(reject|no|n|cancel|stop)$/.test(trimmed)) {
    return 'reject';
  }
  return 'answer';
}

/** Build a summary block from file updates and per-file summaries. */
export function buildChangeSummaryText(
  updates: FileUpdate[],
  summaries: string[]
): { text: string; lines: string[] } {
  const lines = summaries.filter((line) => line && line.trim().length > 0);
  if (lines.length === 0) {
    updates.forEach((update) => {
      lines.push(`- ${update.relativePath}`);
    });
  }
  return { text: lines.join('\n'), lines };
}

/** Run a single, safe preflight tool action to ground the edit request. */
export async function runToolAwarePreflight(
  instruction: string,
  rootPath: string,
  activeFilePath: string | null,
  output: vscode.OutputChannel,
  panelApi: ForgeUiApi | undefined,
  signal?: AbortSignal,
  memoryContext?: string
): Promise<string | null> {
  const projectContext = harvestContext();
  const plannerContext = {
    workspaceRoot: rootPath,
    activeEditorFile: activeFilePath ?? projectContext.activeEditorFile,
    files: projectContext.files,
    packageJson: projectContext.packageJson,
    packageManager: projectContext.packageManager,
    frontendFramework: projectContext.frontendFramework,
    backendFramework: projectContext.backendFramework
  };

  const plan = await compressTask(instruction, plannerContext, getRoutedConfig('plan'), memoryContext);
  recordStep('Tool-aware plan', plan.kind === 'plan' ? plan.steps.join('\n') : plan.questions.join('\n'));
  const toolCall = await nextToolCall({ plan, context: plannerContext }, getRoutedConfig('plan'), memoryContext);
  recordStep('Tool-aware tool', JSON.stringify(toolCall));

  if (signal?.aborted) {
    return null;
  }

  if (toolCall.tool === 'read_file') {
    const resolved = resolveToolPath(rootPath, toolCall.path);
    if (!resolved) {
      return null;
    }
    try {
      const content = fs.readFileSync(resolved.fullPath, 'utf8');
      const trimmed = truncateText(content, 3000);
      return `Tool: read_file\nFile: ${resolved.relativePath}\n${trimmed}`;
    } catch (error) {
      logOutput(output, panelApi, `Tool read error: ${String(error)}`);
      return null;
    }
  }

  if (toolCall.tool === 'request_diff') {
    try {
      const hasGit = await isGitRepo(rootPath);
      if (!hasGit) {
        return null;
      }
      const diff = await getDiff(rootPath, { full: false });
      return diff.trim().length > 0 ? `Tool: request_diff\n${truncateText(diff, 3000)}` : null;
    } catch (error) {
      logOutput(output, panelApi, `Tool diff error: ${String(error)}`);
      return null;
    }
  }

  if (toolCall.tool === 'run_validation_command') {
    const command = toolCall.command?.trim();
    if (!command) {
      return null;
    }
    try {
      const result = await runCommand(command, rootPath, output);
      return `Tool: run_validation_command\nCommand: ${command}\nExit: ${result.code}\n${truncateText(result.output, 3000)}`;
    } catch (error) {
      logOutput(output, panelApi, `Tool validation error: ${String(error)}`);
      return null;
    }
  }

  return null;
}

function resolveToolPath(
  rootPath: string,
  candidate: string
): { fullPath: string; relativePath: string } | null {
  const normalized = path.normalize(candidate.replace(/\//g, path.sep));
  const fullPath = path.isAbsolute(normalized) ? normalized : path.join(rootPath, normalized);
  const relativePath = path.relative(rootPath, fullPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return { fullPath, relativePath };
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}
