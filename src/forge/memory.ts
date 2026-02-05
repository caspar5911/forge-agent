/** Persistent project memory store with optional compaction. */
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage } from '../llm/client';
import { callChatCompletion } from '../llm/client';
import { getRoutedConfig } from '../llm/routing';

export type MemoryEntry = {
  id: string;
  createdAt: string;
  instruction: string;
  intent?: string;
  decisions?: string[];
  filesChanged?: string[];
  constraints?: string[];
  summary?: string;
  validation?: {
    ok: boolean;
    command?: string | null;
    label?: string | null;
  };
  verification?: {
    status?: string;
    confidence?: string;
    issues?: string[];
  };
  outcome?: 'completed' | 'cancelled' | 'error';
};

export type MemoryState = {
  version: 1;
  updatedAt: string;
  compacted?: {
    createdAt: string;
    entries: number;
    summary: string;
  };
  entries: MemoryEntry[];
};

export type MemoryOptions = {
  maxEntries: number;
  maxChars: number;
  compactionTargetEntries: number;
  includeCompacted: boolean;
};

const MEMORY_VERSION: MemoryState['version'] = 1;

/** Resolve the on-disk memory file location for a repo root. */
export function getMemoryFilePath(rootPath: string): string {
  return path.join(rootPath, '.forge', 'memory.json');
}

/** Load memory state from disk if present and valid. */
export function loadMemoryState(rootPath: string): MemoryState | null {
  const filePath = getMemoryFilePath(rootPath);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as MemoryState;
    if (!parsed || parsed.version !== MEMORY_VERSION || !Array.isArray(parsed.entries)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Build a compact memory context string for prompt injection. */
export function buildMemoryContext(state: MemoryState, options: MemoryOptions): string | null {
  const lines: string[] = [];

  if (options.includeCompacted && state.compacted?.summary) {
    lines.push('Compacted memory:');
    lines.push(state.compacted.summary.trim());
  }

  const recentEntries = state.entries.slice(-options.maxEntries);
  for (let i = recentEntries.length - 1; i >= 0; i -= 1) {
    const entry = recentEntries[i];
    const header = `[${entry.createdAt}] ${entry.instruction}`;
    lines.push(header);
    if (entry.intent) {
      lines.push(`Intent: ${entry.intent}`);
    }
    if (entry.filesChanged && entry.filesChanged.length > 0) {
      lines.push(`Files changed: ${entry.filesChanged.join(', ')}`);
    }
    if (entry.decisions && entry.decisions.length > 0) {
      lines.push(`Decisions: ${entry.decisions.join(' | ')}`);
    }
    if (entry.constraints && entry.constraints.length > 0) {
      lines.push(`Constraints: ${entry.constraints.join(' | ')}`);
    }
    if (entry.summary) {
      lines.push(`Summary: ${entry.summary}`);
    }
  }

  if (lines.length === 0) {
    return null;
  }

  let context = lines.join('\n');
  if (context.length > options.maxChars) {
    context = `${context.slice(0, options.maxChars)}\n... (truncated memory)`;
  }
  return context.trim();
}

/** Load memory state and return a prompt-ready context string. */
export function loadMemoryContext(rootPath: string, options: MemoryOptions): string | null {
  const state = loadMemoryState(rootPath);
  if (!state) {
    return null;
  }
  return buildMemoryContext(state, options);
}

/** Append a new run summary to memory, compacting older entries when needed. */
export async function appendRunMemory(
  rootPath: string,
  entry: MemoryEntry,
  options: MemoryOptions,
  signal?: AbortSignal
): Promise<void> {
  const filePath = getMemoryFilePath(rootPath);
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const state = loadMemoryState(rootPath) ?? {
    version: MEMORY_VERSION,
    updatedAt: new Date().toISOString(),
    entries: []
  };

  state.entries.push(entry);
  state.updatedAt = new Date().toISOString();

  await compactIfNeeded(state, options, signal);

  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

async function compactIfNeeded(
  state: MemoryState,
  options: MemoryOptions,
  signal?: AbortSignal
): Promise<void> {
  const totalChars = JSON.stringify(state).length;
  const needsCompaction = state.entries.length > options.maxEntries || totalChars > options.maxChars;
  if (!needsCompaction) {
    return;
  }

  const targetEntries = Math.max(1, options.compactionTargetEntries);
  if (state.entries.length <= targetEntries) {
    return;
  }

  const toCompact = state.entries.slice(0, state.entries.length - targetEntries);
  const remaining = state.entries.slice(-targetEntries);

  const summary = await summarizeEntries(toCompact, signal);
  state.compacted = {
    createdAt: new Date().toISOString(),
    entries: toCompact.length,
    summary
  };
  state.entries = remaining;
}

async function summarizeEntries(entries: MemoryEntry[], signal?: AbortSignal): Promise<string> {
  const fallback = entries
    .map((entry) => {
      const parts = [entry.instruction];
      if (entry.filesChanged && entry.filesChanged.length > 0) {
        parts.push(`files: ${entry.filesChanged.join(', ')}`);
      }
      if (entry.decisions && entry.decisions.length > 0) {
        parts.push(`decisions: ${entry.decisions.join(' | ')}`);
      }
      return `- ${parts.join(' | ')}`;
    })
    .join('\n');

  const prompt = entries
    .map((entry) => {
      const lines = [
        `Instruction: ${entry.instruction}`,
        entry.intent ? `Intent: ${entry.intent}` : null,
        entry.filesChanged && entry.filesChanged.length > 0 ? `Files: ${entry.filesChanged.join(', ')}` : null,
        entry.decisions && entry.decisions.length > 0 ? `Decisions: ${entry.decisions.join(' | ')}` : null,
        entry.constraints && entry.constraints.length > 0 ? `Constraints: ${entry.constraints.join(' | ')}` : null,
        entry.summary ? `Summary: ${entry.summary}` : null
      ].filter(Boolean);
      return lines.join('\n');
    })
    .join('\n\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are compacting project memory. Summarize the key decisions, constraints, and files changed. ' +
        'Return concise bullets only.'
    },
    {
      role: 'user',
      content: `Project memory entries:\n\n${prompt}`
    }
  ];

  try {
    const response = await callChatCompletion(getRoutedConfig('summary'), messages, signal);
    const content = response.choices?.[0]?.message?.content?.trim();
    if (content) {
      return content;
    }
  } catch {
    // fall back to a deterministic summary
  }

  return fallback || 'Compacted memory unavailable.';
}
