/** Question answering and project summary helpers. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { harvestContext, type ProjectContext } from '../context';
import type { ChatMessage } from '../llm/client';
import { callChatCompletion, callChatCompletionStream } from '../llm/client';
import { isAbortError, logOutput } from './logging';
import { listWorkspaceFiles } from './workspaceFiles';
import { extractMentionedFiles, findFileByBasename } from './fileSearch';
import { mergeChatHistory } from './intent';
import type { ChatHistoryItem } from './types';
import type { ForgeUiApi } from '../ui/api';

/** Answer user questions using local context and the LLM when needed. */
export async function answerQuestion(
  instruction: string,
  rootPath: string,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  signal?: AbortSignal,
  history?: ChatHistoryItem[]
): Promise<void> {
  const lowered = instruction.toLowerCase();
  const context = harvestContext();
  const filesList = context.files && context.files.length > 0
    ? context.files
    : listWorkspaceFiles(rootPath, 6, 5000);

  if (isProjectSummaryQuestion(lowered)) {
    const config = vscode.workspace.getConfiguration('forge');
    const maxChars = config.get<number>('projectSummaryMaxChars') ?? 12000;
    const maxFiles = config.get<number>('projectSummaryMaxFiles') ?? 60;
    const maxBytesPerFile = config.get<number>('projectSummaryMaxFileBytes') ?? 60000;
    const chunkChars = config.get<number>('projectSummaryChunkChars') ?? 6000;
    const maxChunks = config.get<number>('projectSummaryMaxChunks') ?? 6;
    const chunksResult = buildProjectSummaryChunks(rootPath, filesList, {
      maxChars,
      maxFiles,
      maxBytesPerFile,
      chunkChars,
      maxChunks
    });
    if (chunksResult.chunks.length === 0) {
      logOutput(output, panelApi, 'No readable files found for summary.');
      return;
    }
    logOutput(output, panelApi, 'Summarizing project in chunks...');
    try {
      const partials: string[] = [];
      for (let i = 0; i < chunksResult.chunks.length; i += 1) {
        const chunk = chunksResult.chunks[i];
        const messages = mergeChatHistory(
          history,
          buildProjectChunkMessages(chunk, i + 1, chunksResult.chunks.length)
        );
        const response = await callChatCompletion({}, messages, signal);
        const content = response.choices?.[0]?.message?.content?.trim();
        if (content) {
          partials.push(content);
        }
      }
      if (partials.length === 0) {
        logOutput(output, panelApi, 'No summary returned.');
        return;
      }

      const finalMessages = mergeChatHistory(
        history,
        buildProjectSummaryFromChunksMessages(instruction, partials)
      );
      if (panelApi?.appendStream) {
        panelApi.startStream?.('assistant');
        const answer = await callChatCompletionStream(
          {},
          finalMessages,
          (delta) => panelApi.appendStream?.(delta),
          signal
        );
        panelApi.endStream?.();
        if (!answer) {
          logOutput(output, panelApi, 'No answer returned.');
          return;
        }
        if (chunksResult.truncated) {
          logOutput(output, panelApi, 'Note: summary context was truncated to fit model limits.');
        }
        output.appendLine(answer);
        return;
      }

      const response = await callChatCompletion({}, finalMessages, signal);
      const answer = response.choices?.[0]?.message?.content?.trim();
      if (!answer) {
        logOutput(output, panelApi, 'No answer returned.');
        return;
      }
      if (chunksResult.truncated) {
        logOutput(output, panelApi, 'Note: summary context was truncated to fit model limits.');
      }
      logOutput(output, panelApi, answer);
      return;
    } catch (error) {
      if (isAbortError(error)) {
        panelApi?.endStream?.();
        logOutput(output, panelApi, 'LLM request aborted.');
        return;
      }
      panelApi?.endStream?.();
      logOutput(output, panelApi, `LLM error: ${String(error)}`);
      return;
    }
  }

  if (lowered.includes('how many files')) {
    const message = `This project has ${filesList.length} files (depth-limited scan).`;
    logOutput(output, panelApi, message);
    return;
  }

  if (/(what|which).*(files|file list)/.test(lowered) || lowered.includes('all the files')) {
    const bulletList = filesList.slice(0, 200).map((file) => `- ${file}`).join('\n');
    const truncated = filesList.length > 200 ? `\n... (${filesList.length - 200} more)` : '';
    logOutput(output, panelApi, `Files (partial list):\n${bulletList}${truncated}`);
    return;
  }

  if (isFileReadQuestion(lowered)) {
    let mentioned = extractMentionedFiles(instruction, filesList);
    if (mentioned.length === 0) {
      const deepList = listWorkspaceFiles(rootPath, 6, 5000);
      mentioned = extractMentionedFiles(instruction, deepList);
      if (mentioned.length === 0) {
        const byBasename = findFileByBasename(instruction, deepList);
        if (byBasename) {
          mentioned = [byBasename];
        }
      }
    }
    if (mentioned.length > 0) {
      const target = mentioned[0];
      const fullPath = path.join(rootPath, target);
      let content = '';
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch (error) {
        logOutput(output, panelApi, `Unable to read ${target}: ${String(error)}`);
        return;
      }
      const maxChars = 2000;
      const snippet = content.length > maxChars ? `${content.slice(0, maxChars)}\n... (truncated)` : content;
      logOutput(output, panelApi, `Content of ${target}:\n${snippet}`);
      return;
    }
  }

  const messages = mergeChatHistory(history, buildQuestionMessages(instruction, context, filesList));
  logOutput(output, panelApi, 'Requesting answer from the local LLM...');
  try {
    if (panelApi?.appendStream) {
      panelApi.startStream?.('assistant');
      const answer = await callChatCompletionStream(
        {},
        messages,
        (delta) => panelApi.appendStream?.(delta),
        signal
      );
      panelApi.endStream?.();
      if (!answer) {
        logOutput(output, panelApi, 'No answer returned.');
        return;
      }
      output.appendLine(answer);
      return;
    }

    const response = await callChatCompletion({}, messages, signal);
    const answer = response.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      logOutput(output, panelApi, 'No answer returned.');
      return;
    }
    logOutput(output, panelApi, answer);
  } catch (error) {
    if (isAbortError(error)) {
      panelApi?.endStream?.();
      logOutput(output, panelApi, 'LLM request aborted.');
      return;
    }
    panelApi?.endStream?.();
    logOutput(output, panelApi, `LLM error: ${String(error)}`);
  }
}

/** Build the prompt used to answer general questions. */
function buildQuestionMessages(
  instruction: string,
  context: ProjectContext,
  filesList: string[]
): ChatMessage[] {
  const preview = filesList.slice(0, 300).join('\n');
  const truncated = filesList.length > 300 ? '\n...(truncated)' : '';

  return [
    {
      role: 'system',
      content:
        'You are a helpful assistant. Answer the question using the provided project context. ' +
        'If the context is insufficient, ask the user for the missing details. ' +
        'Do not claim you lack access; instead request the needed file or data.'
    },
    {
      role: 'user',
      content:
        `Question: ${instruction}\n\n` +
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

/** Detect project overview questions that require summarization. */
function isProjectSummaryQuestion(lowered: string): boolean {
  return (
    lowered.includes('what is this project') ||
    lowered.includes('what this project') ||
    lowered.includes('tell me what this project') ||
    lowered.includes('what is the project') ||
    lowered.includes('project about') ||
    lowered.includes('repo about') ||
    lowered.includes('codebase about')
  );
}

/** Build a single payload of prioritized file content for summarization. */
function buildProjectSummaryPayload(
  rootPath: string,
  filesList: string[],
  limits: { maxChars: number; maxFiles: number; maxBytesPerFile: number }
): { payload: string; truncated: boolean } {
  const maxFiles = Math.max(1, limits.maxFiles);
  const maxBytesPerFile = Math.max(1024, limits.maxBytesPerFile);
  const maxTotalChars = Math.max(2000, limits.maxChars);
  let totalChars = 0;
  let truncated = false;

  const ordered = prioritizeProjectFiles(filesList);
  const parts: string[] = [];

  for (const relativePath of ordered) {
    if (parts.length >= maxFiles || totalChars >= maxTotalChars) {
      truncated = true;
      break;
    }
    const fullPath = path.join(rootPath, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytesPerFile) {
      continue;
    }
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    if (!content.trim()) {
      continue;
    }
    const remaining = maxTotalChars - totalChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const slice = content.length > remaining ? content.slice(0, remaining) : content;
    parts.push(`File: ${relativePath}\n${slice}`);
    totalChars += slice.length;
    if (content.length > remaining) {
      truncated = true;
      break;
    }
  }

  if (totalChars >= maxTotalChars) {
    truncated = true;
    parts.push('---\n[Truncated: payload limit reached]');
  }
  return { payload: parts.join('\n---\n'), truncated };
}

/** Build chunked payloads when the summary would exceed token limits. */
function buildProjectSummaryChunks(
  rootPath: string,
  filesList: string[],
  limits: {
    maxChars: number;
    maxFiles: number;
    maxBytesPerFile: number;
    chunkChars: number;
    maxChunks: number;
  }
): { chunks: string[]; truncated: boolean } {
  const maxFiles = Math.max(1, limits.maxFiles);
  const maxBytesPerFile = Math.max(1024, limits.maxBytesPerFile);
  const maxTotalChars = Math.max(2000, limits.maxChars);
  const chunkChars = Math.max(1000, limits.chunkChars);
  const maxChunks = Math.max(1, limits.maxChunks);
  let totalChars = 0;
  let fileCount = 0;
  let truncated = false;

  const ordered = prioritizeProjectFiles(filesList);
  const chunks: string[] = [];
  let current = '';

  for (const relativePath of ordered) {
    if (chunks.length >= maxChunks || totalChars >= maxTotalChars || fileCount >= maxFiles) {
      truncated = true;
      break;
    }

    const fullPath = path.join(rootPath, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytesPerFile) {
      continue;
    }
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    if (!content.trim()) {
      continue;
    }
    const remaining = maxTotalChars - totalChars;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const slice = content.length > remaining ? content.slice(0, remaining) : content;
    const entry = `File: ${relativePath}\n${slice}`;

    if (current.length + entry.length + 5 > chunkChars) {
      if (current.trim().length > 0) {
        chunks.push(current.trim());
        current = '';
        if (chunks.length >= maxChunks) {
          truncated = true;
          break;
        }
      }
    }

    if (current.length > 0) {
      current += '\n---\n';
    }
    current += entry;
    totalChars += slice.length;
    fileCount += 1;
    if (content.length > remaining) {
      truncated = true;
      break;
    }
  }

  if (current.trim().length > 0 && chunks.length < maxChunks) {
    chunks.push(current.trim());
  }

  if (totalChars >= maxTotalChars) {
    truncated = true;
  }

  return { chunks, truncated };
}

/** Rank files by likely importance for a project summary. */
function prioritizeProjectFiles(filesList: string[]): string[] {
  const priorityPrefixes = [
    'readme',
    'src/main',
    'src/index',
    'src/app',
    'src/pages',
    'src/routes',
    'src/components'
  ];

  const scored = filesList.map((file) => {
    const lower = file.toLowerCase();
    let score = 0;
    if (lower.includes('readme')) {
      score += 5;
    }
    priorityPrefixes.forEach((prefix) => {
      if (lower.startsWith(prefix)) {
        score += 3;
      }
    });
    if (lower.endsWith('.md')) {
      score += 2;
    }
    if (lower.endsWith('.tsx') || lower.endsWith('.ts') || lower.endsWith('.jsx') || lower.endsWith('.js')) {
      score += 1;
    }
    return { file, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.file);
}

/** Build the prompt for single-pass project summarization. */
function buildProjectSummaryMessages(instruction: string, payload: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are summarizing a project based ONLY on the provided file contents. ' +
        'Do not guess. If something is unclear, say it is unclear. ' +
        'Respond in 5-8 concise bullets, then a 1-sentence summary.'
    },
    {
      role: 'user',
      content: `Question: ${instruction}\n\nProject files:\n${payload}`
    }
  ];
}

/** Build the prompt for a single project summary chunk. */
function buildProjectChunkMessages(payload: string, index: number, total: number): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are summarizing a project chunk based ONLY on the provided file contents. ' +
        'Do not guess. Return 4-6 concise bullets.'
    },
    {
      role: 'user',
      content: `Chunk ${index} of ${total}:\n\n${payload}`
    }
  ];
}

/** Build the prompt that combines chunk summaries into a final answer. */
function buildProjectSummaryFromChunksMessages(instruction: string, chunks: string[]): ChatMessage[] {
  const joined = chunks.map((chunk, index) => `Chunk ${index + 1} summary:\n${chunk}`).join('\n\n');
  return [
    {
      role: 'system',
      content:
        'Combine the chunk summaries into a precise project overview. ' +
        'Do not guess. Respond in 5-8 concise bullets, then a 1-sentence summary.'
    },
    {
      role: 'user',
      content: `Question: ${instruction}\n\nChunk summaries:\n${joined}`
    }
  ];
}

/** Fallback detector for file-read questions. */
function isFileReadQuestion(lowered: string): boolean {
  if (/\b(show|open|read|view|display)\b/.test(lowered)) {
    return true;
  }
  if (/\b(content of|contents of|what is in)\b/.test(lowered)) {
    return true;
  }
  if (/\bfile\b/.test(lowered)) {
    return true;
  }
  if (/\.\w{1,5}\b/.test(lowered)) {
    return true;
  }
  return false;
}
