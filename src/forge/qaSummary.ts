/** Project summary helpers for Q&A responses. */
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage } from '../llm/client';

/** Detect project overview questions that require summarization. */
export function isProjectSummaryQuestion(lowered: string): boolean {
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

/** Build chunked payloads when the summary would exceed token limits. */
export function buildProjectSummaryChunks(
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

/** Build the prompt for a single project summary chunk. */
export function buildProjectChunkMessages(payload: string, index: number, total: number): ChatMessage[] {
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
export function buildProjectSummaryFromChunksMessages(instruction: string, chunks: string[]): ChatMessage[] {
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
