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
import { extractKeywords, extractMentionedFiles, findFileByBasename } from './fileSearch';
import { rankFilesByRelevance } from './retrievalRanker';
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

type SourceSnippet = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
};

type RetrievalResult = {
  sources: SourceSnippet[];
  keywords: string[];
  keywordCoverage: number;
};

async function collectRelevantSnippets(
  instruction: string,
  rootPath: string,
  filesList: string[],
  config: vscode.WorkspaceConfiguration,
  signal?: AbortSignal
): Promise<RetrievalResult> {
  const maxFiles = Math.max(1, config.get<number>('qaMaxFiles') ?? 12);
  const maxSnippets = Math.max(1, config.get<number>('qaMaxSnippets') ?? 8);
  const snippetLines = Math.max(1, config.get<number>('qaSnippetLines') ?? 3);
  const maxBytes = Math.max(1024, config.get<number>('qaMaxFileBytes') ?? 200000);
  const keywords = extractKeywords(instruction);
  const mentioned = extractMentionedFiles(instruction, filesList);

  if (keywords.length === 0 && mentioned.length === 0) {
    return { sources: [], keywords, keywordCoverage: 0 };
  }

  const keywordSet = new Set(keywords.map((item) => item.toLowerCase()));

  const scored = filesList.map((file) => {
    const lowerPath = file.toLowerCase();
    let score = 0;
    let contentHits = 0;
    const pathHits = keywords.filter((keyword) => lowerPath.includes(keyword.toLowerCase())).length;
    score += pathHits * 3;
    if (mentioned.includes(file)) {
      score += 10;
    }

    let content: string | null = null;
    if (score > 0 || keywords.length > 0) {
      const fullPath = path.join(rootPath, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        return { file, score: 0, content: null, contentHits: 0 };
      }
      if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) {
        return { file, score, content: null, contentHits: 0 };
      }
      try {
        content = fs.readFileSync(fullPath, 'utf8');
      } catch {
        return { file, score, content: null, contentHits: 0 };
      }
      const lowerContent = content.toLowerCase();
      for (const keyword of keywordSet) {
        if (lowerContent.includes(keyword)) {
          contentHits += 1;
        }
      }
      score += contentHits * 2;
    }

    return { file, score, content, contentHits };
  });

  const ranked = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);

  let ordered = ranked.map((item) => item.file);
  if (ordered.length > 1) {
    ordered = await rankFilesByRelevance(instruction, ordered, rootPath, {
      maxCandidates: maxFiles,
      maxPreviewChars: 400,
      signal
    });
  }

  const rankedByOrder = ordered
    .map((file) => ranked.find((item) => item.file === file))
    .filter((item): item is typeof ranked[number] => Boolean(item));

  const sources: SourceSnippet[] = [];
  const foundKeywords = new Set<string>();
  let snippetId = 1;

  for (const entry of rankedByOrder) {
    if (sources.length >= maxSnippets) {
      break;
    }
    const content = entry.content;
    if (!content) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    const lowerLines = lines.map((line) => line.toLowerCase());
    const hitLines: number[] = [];

    for (const keyword of keywordSet) {
      const index = lowerLines.findIndex((line) => line.includes(keyword));
      if (index >= 0) {
        hitLines.push(index);
        foundKeywords.add(keyword);
      }
    }

    if (hitLines.length === 0 && mentioned.includes(entry.file)) {
      hitLines.push(0);
    }

    for (const hit of hitLines) {
      if (sources.length >= maxSnippets) {
        break;
      }
      const start = Math.max(0, hit - snippetLines);
      const end = Math.min(lines.length - 1, hit + snippetLines);
      const snippet = lines
        .slice(start, end + 1)
        .map((line, idx) => `${start + idx + 1}: ${line}`)
        .join('\n');
      sources.push({
        id: `S${snippetId}`,
        path: entry.file,
        startLine: start + 1,
        endLine: end + 1,
        content: snippet
      });
      snippetId += 1;
    }
  }

  const coverage =
    keywords.length === 0
      ? sources.length > 0
        ? 0.5
        : 0
      : foundKeywords.size / keywords.length;

  return { sources, keywords, keywordCoverage: coverage };
}

function extractNeedsContext(answer: string): string | null {
  const match = answer.match(/needs_context\s*:\s*(.*)/i);
  if (!match) {
    return null;
  }
  const detail = match[1]?.trim();
  return detail && detail.length > 0 ? detail : 'More project context is required.';
}

function computeConfidence(result: RetrievalResult): 'High' | 'Medium' | 'Low' {
  if (result.sources.length >= 2 && result.keywordCoverage >= 0.5) {
    return 'High';
  }
  if (result.sources.length >= 1 && result.keywordCoverage >= 0.2) {
    return 'Medium';
  }
  return 'Low';
}

function appendSourcesAndConfidence(
  answer: string,
  sources: SourceSnippet[],
  confidence: 'High' | 'Medium' | 'Low'
): string {
  const sourceLines = sources.map((source) => {
    const location = `${source.path}:${source.startLine}-${source.endLine}`;
    return `[${source.id}] ${location}`;
  });
  const sourcesBlock = sourceLines.length > 0 ? `Sources:\n${sourceLines.join('\n')}` : 'Sources: none';
  return `${answer}\n\nConfidence: ${confidence}\n${sourcesBlock}`;
}

function buildNeedsContextMessage(
  instruction: string,
  result: RetrievalResult,
  fileCount: number,
  detail?: string | null
): string {
  const keywordHint = result.keywords.length > 0
    ? `Keywords detected: ${result.keywords.join(', ')}. `
    : '';
  const detailHint = detail ? `Missing details: ${detail}. ` : '';
  return (
    'I need more context to answer that confidently. ' +
    detailHint +
    keywordHint +
    `Try pointing me to specific files or areas (workspace has ${fileCount} files).`
  );
}
