/** Build a compact context bundle for edits. */
import * as fs from 'fs';
import * as path from 'path';
import { extractMentionedFiles, findFilesByKeywords } from './fileSearch';
import { listWorkspaceFiles } from './workspaceFiles';
import { rankFilesByRelevance } from './retrievalRanker';

type ContextBundle = {
  text: string;
  files: string[];
};

export async function buildContextBundle(
  instruction: string,
  rootPath: string,
  maxFiles: number = 3,
  maxCharsPerFile: number = 2000,
  signal?: AbortSignal
): Promise<ContextBundle | null> {
  const filesList = listWorkspaceFiles(rootPath, 4, 2000);
  const mentioned = extractMentionedFiles(instruction, filesList);
  const keywordMatches = await findFilesByKeywords(instruction, rootPath, filesList);
  const candidates = Array.from(new Set([...mentioned, ...keywordMatches]));

  let rankedCandidates = candidates;
  if (candidates.length > 1) {
    rankedCandidates = await rankFilesByRelevance(instruction, candidates, rootPath, {
      maxCandidates: Math.max(maxFiles, 8),
      maxPreviewChars: 400,
      signal
    });
  }

  const selected = rankedCandidates.slice(0, maxFiles);

  if (selected.length === 0) {
    return null;
  }

  const snippets: string[] = [];
  const used: string[] = [];
  for (const relativePath of selected) {
    const fullPath = path.join(rootPath, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) {
      continue;
    }
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    const slice = content.length > maxCharsPerFile ? `${content.slice(0, maxCharsPerFile)}\n... (truncated)` : content;
    snippets.push(`File: ${relativePath}\n${slice}`);
    used.push(relativePath);
  }

  if (snippets.length === 0) {
    return null;
  }

  return { text: snippets.join('\n---\n'), files: used };
}
