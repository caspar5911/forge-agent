/** File selection helpers for multi-file updates. */
import * as path from 'path';
import { recordStep } from './trace';
import { findFilesByKeywords } from './fileSearch';

export type AutoSelectionInput = {
  directFiles: string[];
  filesList: string[];
  suggestedFiles: string[];
  allowNewFiles: boolean;
  skipCreateFilePicker: boolean;
  instruction: string;
};

export type AutoSelectionResult = {
  autoSelectedFiles: string[];
  shouldOfferPicker: boolean;
};

export type SelectionCandidateInput = {
  selectedFiles: string[];
  mentionedFiles: string[];
  explicitPaths: string[];
  filesList: string[];
  rootPath: string;
  activeRelativePath: string | null;
  instruction: string;
};

type DisambiguationResult = {
  paths: string[];
  notes: string[];
};

/** Decide whether to auto-select files or show the picker. */
export function computeAutoSelection(input: AutoSelectionInput): AutoSelectionResult {
  const disambiguatedDirect = disambiguateCandidatePaths(input.directFiles, input.filesList);
  if (disambiguatedDirect.notes.length > 0) {
    recordStep('Basename disambiguation', disambiguatedDirect.notes.join('\n'));
  }

  const autoSelectedFiles =
    disambiguatedDirect.paths.length > 0
      ? disambiguatedDirect.paths
      : isSmallEditInstruction(input.instruction) && input.suggestedFiles.length === 1
        ? input.suggestedFiles
        : [];

  const shouldSkipPicker = input.allowNewFiles && input.skipCreateFilePicker;
  const shouldOfferPicker =
    !shouldSkipPicker && autoSelectedFiles.length === 0 && input.suggestedFiles.length > 1;

  return { autoSelectedFiles, shouldOfferPicker };
}

/** Merge selection sources, disambiguate, and apply fallback paths. */
export async function resolveSelectionCandidates(input: SelectionCandidateInput): Promise<string[]> {
  const candidateSet = new Set<string>([
    ...input.selectedFiles.map((item) => String(item)),
    ...input.mentionedFiles,
    ...input.explicitPaths
  ]);
  const candidates = Array.from(candidateSet);

  if (candidates.length === 0) {
    const keywordMatches = await findFilesByKeywords(input.instruction, input.rootPath, input.filesList);
    keywordMatches.forEach((match) => candidateSet.add(match));
  }

  const disambiguated = disambiguateCandidatePaths(Array.from(candidateSet), input.filesList);
  if (disambiguated.notes.length > 0) {
    recordStep('Basename disambiguation', disambiguated.notes.join('\n'));
  }

  if (disambiguated.paths.length === 0 && input.activeRelativePath) {
    disambiguated.paths.push(input.activeRelativePath);
  }

  return disambiguated.paths;
}

/** Resolve and validate a workspace-relative file path. */
export function resolveWorkspacePath(
  rootPath: string,
  candidate: string
): { fullPath: string; relativePath: string } | null {
  const normalized = path.normalize(candidate.replace(/\//g, path.sep));
  const isAbsolute = path.isAbsolute(normalized);
  const fullPath = isAbsolute ? normalized : path.join(rootPath, normalized);
  const relativePath = path.relative(rootPath, fullPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  if (hasBlockedPathSegment(relativePath)) {
    return null;
  }
  return { fullPath, relativePath };
}

/** Prefer a stable path when multiple files share the same basename. */
function disambiguateCandidatePaths(candidates: string[], filesList: string[]): DisambiguationResult {
  const normalizedFiles = filesList.map((file) => file.replace(/\\/g, '/'));
  const notes: string[] = [];
  const resolved: string[] = [];

  for (const candidate of candidates) {
    const normalizedCandidate = candidate.replace(/\\/g, '/');
    if (normalizedCandidate.includes('/')) {
      resolved.push(normalizedCandidate);
      continue;
    }
    const base = normalizedCandidate.toLowerCase();
    const matches = normalizedFiles.filter(
      (file) => path.posix.basename(file).toLowerCase() === base
    );
    if (matches.length === 0) {
      resolved.push(normalizedCandidate);
      continue;
    }
    const preferred = pickPreferredMatch(matches);
    if (preferred && preferred !== normalizedCandidate) {
      notes.push(`${normalizedCandidate} -> ${preferred}`);
    }
    resolved.push(preferred ?? normalizedCandidate);
  }

  const unique = Array.from(new Set(resolved));
  return { paths: unique, notes };
}

function pickPreferredMatch(matches: string[]): string {
  const preferSrc = matches.find((file) => file.startsWith('src/') || file.includes('/src/'));
  if (preferSrc) {
    return preferSrc;
  }
  const preferApp = matches.find((file) => file.startsWith('app/') || file.includes('/app/'));
  if (preferApp) {
    return preferApp;
  }
  return matches.slice().sort((a, b) => a.length - b.length)[0];
}

function hasBlockedPathSegment(value: string): boolean {
  const parts = value.split(path.sep).map((part) => part.toLowerCase());
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

/** Heuristic: detect small, localized edits that likely target a single file. */
function isSmallEditInstruction(instruction: string): boolean {
  return /\b(typo|spelling|format|reformat|lint|cleanup|minor|small|simple|rename|comment|docs?)\b/i.test(instruction);
}
