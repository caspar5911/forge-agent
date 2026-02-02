import * as fs from 'fs';
import * as path from 'path';

export function extractKeywords(instruction: string): string[] {
  const stopwords = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'to',
    'of',
    'for',
    'in',
    'on',
    'with',
    'add',
    'create',
    'update',
    'change',
    'fix',
    'make',
    'file',
    'files',
    'app'
  ]);
  return instruction
    .split(/[^a-zA-Z0-9_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 3)
    .filter((token) => !stopwords.has(token.toLowerCase()));
}

export function extractMentionedFiles(instruction: string, filesList: string[]): string[] {
  const lowered = instruction.toLowerCase();
  const mentioned = filesList.filter((file) => lowered.includes(file.toLowerCase()));
  if (mentioned.length > 0) {
    return mentioned;
  }

  const baseNameMatches = filesList.filter((file) => {
    const base = path.basename(file).toLowerCase();
    return base.length > 0 && lowered.includes(base);
  });
  return baseNameMatches;
}

export function findFileByBasename(instruction: string, filesList: string[]): string | null {
  const tokens = instruction
    .split(/[^a-zA-Z0-9._-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  for (const token of tokens) {
    const lowered = token.toLowerCase();
    const match = filesList.find((file) => path.basename(file).toLowerCase().startsWith(lowered));
    if (match) {
      return match;
    }
  }

  return null;
}

export async function findFilesByKeywords(
  instruction: string,
  rootPath: string,
  filesList: string[]
): Promise<string[]> {
  const keywords = extractKeywords(instruction).slice(0, 3);
  if (keywords.length === 0) {
    return [];
  }

  const hits = new Set<string>();
  const maxHits = 5;
  const maxBytes = 200_000;

  for (const relativePath of filesList) {
    if (hits.size >= maxHits) {
      break;
    }
    const fullPath = path.join(rootPath, relativePath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > maxBytes) {
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    const lowerContent = content.toLowerCase();
    if (keywords.some((keyword) => lowerContent.includes(keyword.toLowerCase()))) {
      hits.add(relativePath);
    }
  }

  return Array.from(hits);
}
