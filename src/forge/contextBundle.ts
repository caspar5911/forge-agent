/** Build a compact context bundle for edits. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { extractMentionedFiles, findFilesByKeywords } from './fileSearch';
import { listWorkspaceFiles } from './workspaceFiles';
import { rankFilesByRelevance } from './retrievalRanker';
import { searchEmbeddings } from './embeddingsIndex';

type ContextBundle = {
  text: string;
  files: string[];
};

/** Collect a small, ranked set of file snippets to ground an edit request. */
export async function buildContextBundle(
  instruction: string,
  rootPath: string,
  maxFiles: number = 3,
  maxCharsPerFile: number = 2000,
  signal?: AbortSignal
): Promise<ContextBundle | null> {
  const filesList = listWorkspaceFiles(rootPath, 4, 2000);
  const config = vscode.workspace.getConfiguration('forge');

  // Prefer embedding hits when enabled; fall back to keyword + ranking when unavailable.
  const embeddingHits = await searchEmbeddings(instruction, rootPath, filesList, config, signal);
  if (embeddingHits && embeddingHits.length > 0) {
    const snippets: string[] = [];
    const used: string[] = [];

    embeddingHits.slice(0, maxFiles).forEach((hit) => {
      snippets.push(`File: ${hit.path} (${hit.startLine}-${hit.endLine})\n${hit.content}`);
      if (!used.includes(hit.path)) {
        used.push(hit.path);
      }
    });

    if (snippets.length > 0) {
      return { text: snippets.join('\n---\n'), files: used };
    }
  }

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
