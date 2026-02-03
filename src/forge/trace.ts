/** Lightweight run trace collection for UI peek panels. */
import type { ChatMessage } from '../llm/client';

export type TraceEntry = {
  kind: 'step' | 'prompt' | 'response' | 'payload' | 'validation' | 'diff' | 'info';
  title: string;
  content: string;
  sensitive?: boolean;
};

const MAX_ENTRIES = 200;
const MAX_CONTENT_CHARS = 8000;
const SECRET_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  { regex: /(api[_-]?key\s*[:=]\s*)([A-Za-z0-9_\-]{16,})/gi, replacement: '$1[redacted]' },
  { regex: /(x-api-key\s*:\s*)([A-Za-z0-9_\-]{16,})/gi, replacement: '$1[redacted]' },
  { regex: /(authorization\s*:\s*bearer\s+)([A-Za-z0-9._~+\\/=\\-]{16,})/gi, replacement: '$1[redacted]' },
  { regex: /(bearer\s+)([A-Za-z0-9._~+\\/=\\-]{16,})/gi, replacement: '$1[redacted]' },
  { regex: /(sk-[A-Za-z0-9]{16,})/g, replacement: '[redacted]' },
  { regex: /("apiKey"\s*:\s*")([^"]+)(")/gi, replacement: '$1[redacted]$3' },
  { regex: /("api_key"\s*:\s*")([^"]+)(")/gi, replacement: '$1[redacted]$3' },
  { regex: /(OPENAI_API_KEY\s*=\s*)([^\s]+)/gi, replacement: '$1[redacted]' }
];

let activeTrace: TraceEntry[] | null = null;

export function startTrace(): void {
  activeTrace = [];
}

export function endTrace(): TraceEntry[] {
  const entries = activeTrace ?? [];
  activeTrace = null;
  return entries;
}

export function recordTrace(entry: TraceEntry): void {
  if (!activeTrace) {
    return;
  }
  if (activeTrace.length >= MAX_ENTRIES) {
    return;
  }
  const redacted = redactSecrets(entry.content);
  const content = truncate(redacted.text, MAX_CONTENT_CHARS);
  const sensitive = entry.sensitive === true || redacted.redacted;
  activeTrace.push({ ...entry, content, sensitive });
}

export function recordStep(title: string, content: string): void {
  recordTrace({ kind: 'step', title, content });
}

export function recordPayload(title: string, content: string): void {
  recordTrace({ kind: 'payload', title, content });
}

export function recordPrompt(title: string, messages: ChatMessage[], hideSystem: boolean = true): void {
  const lines: string[] = [];
  let systemHidden = false;
  for (const message of messages) {
    if (message.role === 'system') {
      if (hideSystem) {
        systemHidden = true;
        continue;
      }
    }
    lines.push(`[${message.role}] ${message.content}`);
  }
  if (systemHidden) {
    lines.push('[system prompt hidden]');
  }
  recordTrace({
    kind: 'prompt',
    title,
    content: lines.join('\n\n')
  });
}

export function recordResponse(title: string, content: string): void {
  recordTrace({ kind: 'response', title, content });
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n... (truncated)`;
}

function redactSecrets(value: string): { text: string; redacted: boolean } {
  let text = value;
  let redacted = false;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern.regex, (match, prefix, key, suffix) => {
      redacted = true;
      if (typeof prefix === 'string' && typeof key === 'string') {
        if (typeof suffix === 'string') {
          return `${prefix}[redacted]${suffix}`;
        }
        return `${prefix}[redacted]`;
      }
      return match.includes('[') ? match : '[redacted]';
    });
  }
  return { text, redacted };
}
