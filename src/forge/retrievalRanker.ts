/** LLM-assisted re-ranking for candidate files. */
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage } from '../llm/client';
import { requestStructuredJson } from '../llm/structured';
import { RETRIEVAL_RANK_SCHEMA } from './schemas';
import { recordPrompt, recordResponse, recordStep } from './trace';

type RankOptions = {
  maxCandidates?: number;
  maxPreviewChars?: number;
  signal?: AbortSignal;
};

type RankPayload = {
  ordered: string[];
};

/** Ask the LLM to rank candidate files by relevance to the instruction. */
export async function rankFilesByRelevance(
  instruction: string,
  candidates: string[],
  rootPath: string,
  options: RankOptions = {}
): Promise<string[]> {
  const unique = Array.from(new Set(candidates));
  if (unique.length <= 1) {
    return unique;
  }

  const maxCandidates = Math.max(2, options.maxCandidates ?? 12);
  const maxPreviewChars = Math.max(200, options.maxPreviewChars ?? 400);
  const trimmedCandidates = unique.slice(0, maxCandidates);
  const previews = buildFilePreviews(trimmedCandidates, rootPath, maxPreviewChars);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You rank files by relevance to a coding instruction. ' +
        'Return ONLY valid JSON: {"ordered":["path1","path2",...]}. ' +
        'Only include paths from the candidates list, ordered most relevant to least.'
    },
    {
      role: 'user',
      content:
        `Instruction:\n${instruction}\n\n` +
        'Candidates:\n' +
        trimmedCandidates.map((file) => `- ${file}`).join('\n') +
        '\n\nPreviews:\n' +
        previews.join('\n\n')
    }
  ];

  recordPrompt('Retrieval re-rank prompt', messages, true);
  try {
    const payload = await requestStructuredJson<RankPayload>(messages, RETRIEVAL_RANK_SCHEMA, {
      signal: options.signal
    });
    recordResponse('Retrieval re-rank response', JSON.stringify(payload));
    const ordered = Array.isArray(payload.ordered) ? payload.ordered.map((item) => String(item)) : [];
    const filtered = ordered.filter((item) => trimmedCandidates.includes(item));
    const remaining = trimmedCandidates.filter((item) => !filtered.includes(item));
    const ranked = [...filtered, ...remaining];
    recordStep('Retrieval re-rank', ranked.join('\n'));
    return ranked;
  } catch (error) {
    recordStep('Retrieval re-rank fallback', String(error));
    return trimmedCandidates;
  }
}

function buildFilePreviews(
  files: string[],
  rootPath: string,
  maxChars: number
): string[] {
  const previews: string[] = [];
  const maxBytes = 200_000;

  for (const file of files) {
    const fullPath = path.join(rootPath, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      previews.push(`File: ${file}\n(Preview unavailable)`);
      continue;
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) {
      previews.push(`File: ${file}\n(Preview unavailable)`);
      continue;
    }
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      previews.push(`File: ${file}\n(Preview unavailable)`);
      continue;
    }
    const slice = content.length > maxChars ? `${content.slice(0, maxChars)}\n... (truncated)` : content;
    previews.push(`File: ${file}\n${slice}`);
  }

  return previews;
}
