/** Plan summary helper (no chain-of-thought). */
import * as vscode from 'vscode';
import { harvestContext } from '../context';
import type { ChatMessage } from '../llm/client';
import { requestStructuredJson } from '../llm/structured';
import { PLAN_SUMMARY_SCHEMA } from './schemas';
import { mergeChatHistory } from './intent';
import { listWorkspaceFiles } from './workspaceFiles';
import { recordPrompt, recordResponse, recordStep } from './trace';
import type { ChatHistoryItem } from './types';
import type { ForgeUiApi } from '../ui/api';
import { getRoutedConfig } from '../llm/routing';

type PlanSummary = {
  plan: string[];
};

/** Generate a short plan summary for the instruction. */
export async function generatePlanSummary(
  instruction: string,
  rootPath: string,
  output: vscode.OutputChannel,
  panelApi: ForgeUiApi | undefined,
  signal?: AbortSignal,
  history?: ChatHistoryItem[],
  memoryContext?: string
): Promise<string[] | null> {
  const context = harvestContext();
  const filesList = context.files && context.files.length > 0
    ? context.files
    : listWorkspaceFiles(rootPath, 3, 200);
  const preview = filesList.slice(0, 80).join('\n');
  const truncated = filesList.length > 80 ? '\n...(truncated)' : '';

  const memoryBlock = memoryContext ? `\n\nProject memory:\n${memoryContext}` : '';
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are planning a coding task. Return ONLY valid JSON: {"plan":["step1","step2",...]}. ' +
        'Keep the plan concise (3-6 steps). Do not include chain-of-thought or explanations.'
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
        )}${memoryBlock}\n\n` +
        'Files (partial list):\n' +
        preview +
        truncated
    }
  ];

  const merged = mergeChatHistory(history, messages);
  recordPrompt('Plan summary prompt', merged, true);
  try {
    const payload = await requestStructuredJson<PlanSummary>(merged, PLAN_SUMMARY_SCHEMA, {
      signal,
      config: getRoutedConfig('plan')
    });
    recordResponse('Plan summary response', JSON.stringify(payload));
    const plan = Array.isArray(payload.plan) ? payload.plan.map((item) => String(item)).filter(Boolean) : [];
    if (plan.length === 0) {
      return null;
    }
    recordStep('Plan summary', plan.map((item) => `- ${item}`).join('\n'));
    return plan.slice(0, 6);
  } catch (error) {
    output.appendLine(`Plan summary error: ${String(error)}`);
    return null;
  }
}
