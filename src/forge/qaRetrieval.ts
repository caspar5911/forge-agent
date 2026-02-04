/** Retrieval helpers for grounded Q&A responses. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { extractKeywords, extractMentionedFiles } from './fileSearch';
import { rankFilesByRelevance } from './retrievalRanker';

export type SourceSnippet = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
};

export type RetrievalResult = {
  sources: SourceSnippet[];
  keywords: string[];
  keywordCoverage: number;
};

/** Collect relevant code snippets to ground a Q&A response. */
export async function collectRelevantSnippets(
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

/** Extract a NEEDS_CONTEXT request from an LLM answer, if present. */
export function extractNeedsContext(answer: string): string | null {
  const match = answer.match(/needs_context\s*:\s*(.*)/i);
  if (!match) {
    return null;
  }
  const detail = match[1]?.trim();
  return detail && detail.length > 0 ? detail : 'More project context is required.';
}

/** Compute a coarse confidence score from retrieval coverage. */
export function computeConfidence(result: RetrievalResult): 'High' | 'Medium' | 'Low' {
  if (result.sources.length >= 2 && result.keywordCoverage >= 0.5) {
    return 'High';
  }
  if (result.sources.length >= 1 && result.keywordCoverage >= 0.2) {
    return 'Medium';
  }
  return 'Low';
}

/** Append sources and confidence to the final Q&A response. */
export function appendSourcesAndConfidence(
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

/** Build a user-facing response when retrieval lacks enough context. */
export function buildNeedsContextMessage(
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
