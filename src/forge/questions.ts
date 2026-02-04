/** Question answering and project summary helpers. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { harvestContext, type ProjectContext } from '../context';
import type { ChatMessage } from '../llm/client';
import { callChatCompletion } from '../llm/client';
import { isAbortError, logOutput } from './logging';
import { recordPrompt, recordResponse, recordStep } from './trace';
import { listWorkspaceFiles } from './workspaceFiles';
import { extractMentionedFiles, findFileByBasename } from './fileSearch';
import { mergeChatHistory } from './intent';
import {
  appendSourcesAndConfidence,
  buildNeedsContextMessage,
  collectRelevantSnippets,
  computeConfidence,
  extractNeedsContext,
  type SourceSnippet,
  type RetrievalResult
} from './qaRetrieval';
import {
  buildProjectChunkMessages,
  buildProjectSummaryChunks,
  buildProjectSummaryFromChunksMessages,
  isProjectSummaryQuestion
} from './qaSummary';
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
  const config = vscode.workspace.getConfiguration('forge');
  const context = harvestContext();
  const filesList = context.files && context.files.length > 0
    ? context.files
    : listWorkspaceFiles(rootPath, 6, 5000);

  if (isProjectSummaryQuestion(lowered)) {
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
        recordPrompt(`Project summary chunk ${i + 1}/${chunksResult.chunks.length} prompt`, messages, true);
        const response = await callChatCompletion({}, messages, signal);
        const content = response.choices?.[0]?.message?.content?.trim();
        if (content) {
          recordResponse(`Project summary chunk ${i + 1}/${chunksResult.chunks.length} response`, content);
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
      recordPrompt('Project summary prompt', finalMessages, true);
      const response = await callChatCompletion({}, finalMessages, signal);
      const answer = response.choices?.[0]?.message?.content?.trim();
      if (!answer) {
        logOutput(output, panelApi, 'No answer returned.');
        return;
      }
      recordResponse('Project summary response', answer);
      if (chunksResult.truncated) {
        logOutput(output, panelApi, 'Note: summary context was truncated to fit model limits.');
      }
      logOutput(output, panelApi, answer);
      return;
    } catch (error) {
      if (isAbortError(error)) {
        logOutput(output, panelApi, 'LLM request aborted.');
        return;
      }
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

  const retrieval = await collectRelevantSnippets(instruction, rootPath, filesList, config, signal);
  if (retrieval.sources.length > 0) {
    const sourceList = retrieval.sources
      .map((source) => `${source.id} ${source.path}:${source.startLine}-${source.endLine}`)
      .join('\n');
    recordStep('Q&A sources', sourceList);
  }
  const minSources = Math.max(1, config.get<number>('qaMinSources') ?? 1);
  if (retrieval.sources.length < minSources) {
    logOutput(
      output,
      panelApi,
      buildNeedsContextMessage(instruction, retrieval, filesList.length)
    );
    return;
  }

  const messages = mergeChatHistory(
    history,
    buildGroundedQuestionMessages(instruction, context, retrieval.sources)
  );
  recordPrompt('Q&A prompt', messages, true);
  logOutput(output, panelApi, 'Requesting answer from the local LLM...');
  try {
    const response = await callChatCompletion({}, messages, signal);
    const answer = response.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      logOutput(output, panelApi, 'No answer returned.');
      return;
    }
    recordResponse('Q&A response', answer);
    const needsContext = extractNeedsContext(answer);
    if (needsContext) {
      logOutput(output, panelApi, buildNeedsContextMessage(instruction, retrieval, filesList.length, needsContext));
      return;
    }
    const confidence = computeConfidence(retrieval);
    const finalAnswer = appendSourcesAndConfidence(answer, retrieval.sources, confidence);
    logOutput(output, panelApi, finalAnswer);
  } catch (error) {
    if (isAbortError(error)) {
      logOutput(output, panelApi, 'LLM request aborted.');
      return;
    }
    logOutput(output, panelApi, `LLM error: ${String(error)}`);
  }
}

/** Build the prompt used to answer grounded questions with citations. */
function buildGroundedQuestionMessages(
  instruction: string,
  context: ProjectContext,
  sources: SourceSnippet[]
): ChatMessage[] {
  const sourcesBlock = sources
    .map((source) => {
      const location = `${source.path}:${source.startLine}-${source.endLine}`;
      return `[${source.id}] ${location}\n${source.content}`;
    })
    .join('\n\n');

  return [
    {
      role: 'system',
      content:
        'You are a helpful assistant. Answer the question using ONLY the provided sources. ' +
        'Cite sources inline using [S1], [S2], etc. ' +
        'If the sources are insufficient, respond with "NEEDS_CONTEXT: <what is missing>". ' +
        'Keep the answer concise and factual.'
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
        'Sources:\n' +
        sourcesBlock
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
