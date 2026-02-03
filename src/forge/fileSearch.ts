/** File search helpers for choosing relevant targets. */
import * as fs from 'fs';
import * as path from 'path';

/** Extract non-trivial keywords from an instruction for matching. */
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

/** Find files directly mentioned in the instruction. */
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

/** Extract explicit path-like tokens from the instruction (even if they do not exist yet). */
export function extractExplicitPaths(instruction: string): string[] {
  const matches = instruction.matchAll(
    /(?:^|[\s"'`])([A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)*\.[A-Za-z0-9]{1,8})(?=$|[\s"'`.,;:!?])/g
  );
  const found = new Set<string>();
  for (const match of matches) {
    const raw = match[1];
    if (!raw) {
      continue;
    }
    if (raw.includes('://')) {
      continue;
    }
    const normalized = raw.replace(/\\/g, '/');
    if (!hasAllowedExtension(normalized)) {
      continue;
    }
    if (hasDisallowedSegment(normalized)) {
      continue;
    }
    if (isLikelyLibraryToken(normalized)) {
      continue;
    }
    found.add(normalized);
  }
  return Array.from(found);
}

function hasAllowedExtension(value: string): boolean {
  const ext = path.extname(value).toLowerCase().replace('.', '');
  if (!ext) {
    return false;
  }
  const allowed = new Set([
    'ts',
    'tsx',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'json',
    'md',
    'mdx',
    'css',
    'scss',
    'sass',
    'less',
    'html',
    'htm',
    'yml',
    'yaml',
    'toml',
    'txt',
    'svg',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp',
    'ico'
  ]);
  return allowed.has(ext);
}

function hasDisallowedSegment(value: string): boolean {
  const parts = value.split('/').map((part) => part.toLowerCase());
  const blocked = new Set([
    'node_modules',
    '.git',
    'dist',
    'out',
    'build',
    'coverage',
    '.next',
    '.nuxt',
    '.svelte-kit',
    '.vite',
    '.cache'
  ]);
  return parts.some((part) => blocked.has(part));
}

function isLikelyLibraryToken(value: string): boolean {
  const base = path.basename(value);
  const baseLower = base.replace(/\.[^.]+$/, '').toLowerCase();
  const blocked = new Set([
    'react',
    'react-dom',
    'vue',
    'vuejs',
    'angular',
    'svelte',
    'sveltekit',
    'next',
    'nextjs',
    'nuxt',
    'nuxtjs',
    'vite',
    'astro',
    'solid',
    'ember',
    'node',
    'express',
    'nestjs'
  ]);
  return blocked.has(baseLower);
}

/** Try to match a file by basename prefix from the instruction. */
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

/** Search file contents for keyword hits to suggest targets. */
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
