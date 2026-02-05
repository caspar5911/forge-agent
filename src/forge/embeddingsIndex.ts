/** Lightweight embeddings index for repo snippets. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { OpenAIEmbeddings } from '@langchain/openai';
import { DEFAULT_LLM_ENDPOINT, DEFAULT_TIMEOUT_MS } from '../llm/config';

export type EmbeddingSearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
};

type EmbeddingRecord = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  vector: number[];
};

type EmbeddingIndex = {
  version: 1;
  model: string;
  endpoint: string;
  chunkChars: number;
  maxFileBytes: number;
  createdAt: string;
  updatedAt: string;
  records: EmbeddingRecord[];
};

type EmbeddingSettings = {
  enabled: boolean;
  model: string;
  endpoint: string;
  apiKey?: string;
  timeoutMs: number;
  maxFiles: number;
  maxFileBytes: number;
  chunkChars: number;
  topK: number;
  minScore: number;
};

const INDEX_VERSION: EmbeddingIndex['version'] = 1;
const indexCache = new Map<string, EmbeddingIndex>();

/** Run a vector search against the repo embeddings index. */
export async function searchEmbeddings(
  instruction: string,
  rootPath: string,
  filesList: string[],
  config: vscode.WorkspaceConfiguration,
  signal?: AbortSignal
): Promise<EmbeddingSearchResult[] | null> {
  const settings = resolveEmbeddingSettings(config);
  if (!settings.enabled) {
    return null;
  }

  const index = await ensureIndex(rootPath, filesList, settings, signal);
  if (!index || index.records.length === 0) {
    return null;
  }

  if (signal?.aborted) {
    return null;
  }

  try {
    const embeddings = buildEmbeddingsClient(settings);
    const queryVector = await embeddings.embedQuery(instruction);
    const scored = index.records.map((record) => ({
      record,
      score: cosineSimilarity(queryVector, record.vector)
    }));
    scored.sort((a, b) => b.score - a.score);

    const top = scored.slice(0, settings.topK);
    if (top.length === 0 || top[0].score < settings.minScore) {
      return null;
    }

    return top
      .filter((item) => item.score >= settings.minScore)
      .map((item) => ({
        path: item.record.path,
        startLine: item.record.startLine,
        endLine: item.record.endLine,
        content: item.record.content,
        score: item.score
      }));
  } catch {
    return null;
  }
}

function resolveEmbeddingSettings(config: vscode.WorkspaceConfiguration): EmbeddingSettings {
  const enabled = config.get<boolean>('embeddingEnabled') === true;
  const model = (config.get<string>('embeddingModel') ?? '').trim();
  const endpoint = (config.get<string>('embeddingEndpoint') ?? config.get<string>('llmEndpoint') ?? DEFAULT_LLM_ENDPOINT)
    .trim();
  const apiKey = (config.get<string>('embeddingApiKey') ?? config.get<string>('llmApiKey') ?? '').trim();
  const timeoutMs = config.get<number>('embeddingTimeoutMs') ?? config.get<number>('llmTimeoutMs') ?? DEFAULT_TIMEOUT_MS;

  return {
    enabled: enabled && model.length > 0,
    model,
    endpoint,
    apiKey: apiKey.length > 0 ? apiKey : undefined,
    timeoutMs,
    maxFiles: Math.max(1, config.get<number>('embeddingMaxFiles') ?? 200),
    maxFileBytes: Math.max(1024, config.get<number>('embeddingMaxFileBytes') ?? 200000),
    chunkChars: Math.max(400, config.get<number>('embeddingChunkChars') ?? 1200),
    topK: Math.max(1, config.get<number>('embeddingTopK') ?? 8),
    minScore: Math.max(0, config.get<number>('embeddingMinScore') ?? 0.2)
  };
}

async function ensureIndex(
  rootPath: string,
  filesList: string[],
  settings: EmbeddingSettings,
  signal?: AbortSignal
): Promise<EmbeddingIndex | null> {
  const cacheKey = `${rootPath}|${settings.model}|${settings.endpoint}`;
  const cached = indexCache.get(cacheKey);
  const latestMtime = getLatestMtime(rootPath, filesList);

  if (cached && Date.parse(cached.updatedAt) >= latestMtime) {
    return cached;
  }

  const filePath = getIndexPath(rootPath);
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as EmbeddingIndex;
      if (
        parsed &&
        parsed.version === INDEX_VERSION &&
        parsed.model === settings.model &&
        parsed.endpoint === settings.endpoint &&
        parsed.chunkChars === settings.chunkChars &&
        parsed.maxFileBytes === settings.maxFileBytes &&
        Date.parse(parsed.updatedAt) >= latestMtime
      ) {
        indexCache.set(cacheKey, parsed);
        return parsed;
      }
    } catch {
      // Fall through to rebuild.
    }
  }

  const rebuilt = await buildIndex(rootPath, filesList, settings, signal);
  if (rebuilt) {
    indexCache.set(cacheKey, rebuilt);
  }
  return rebuilt;
}

async function buildIndex(
  rootPath: string,
  filesList: string[],
  settings: EmbeddingSettings,
  signal?: AbortSignal
): Promise<EmbeddingIndex | null> {
  const selectedFiles = filesList.slice(0, settings.maxFiles);
  const records: EmbeddingRecord[] = [];
  const contents: string[] = [];

  for (const file of selectedFiles) {
    if (signal?.aborted) {
      return null;
    }
    const fullPath = path.join(rootPath, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0 || stat.size > settings.maxFileBytes) {
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

    const chunks = chunkText(content, settings.chunkChars);
    chunks.forEach((chunk, index) => {
      const id = `${file}#${index}`;
      records.push({
        id,
        path: file,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        vector: []
      });
      contents.push(chunk.content);
    });
  }

  if (records.length === 0) {
    return null;
  }

  try {
    const embeddings = buildEmbeddingsClient(settings);
    const vectors = await embeddings.embedDocuments(contents);
    vectors.forEach((vector, index) => {
      records[index].vector = vector;
    });
  } catch {
    return null;
  }

  const now = new Date().toISOString();
  const index: EmbeddingIndex = {
    version: INDEX_VERSION,
    model: settings.model,
    endpoint: settings.endpoint,
    chunkChars: settings.chunkChars,
    maxFileBytes: settings.maxFileBytes,
    createdAt: now,
    updatedAt: now,
    records
  };

  const filePath = getIndexPath(rootPath);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(index), 'utf8');
  } catch {
    // Index is best-effort; continue without persistence.
  }

  return index;
}

function buildEmbeddingsClient(settings: EmbeddingSettings): OpenAIEmbeddings {
  const baseURL = settings.endpoint.replace(/\/$/, '');
  const apiKey = settings.apiKey ?? 'local';
  return new OpenAIEmbeddings({
    modelName: settings.model,
    openAIApiKey: apiKey,
    timeout: settings.timeoutMs,
    configuration: {
      baseURL
    }
  });
}

function chunkText(
  text: string,
  chunkChars: number
): Array<{ content: string; startLine: number; endLine: number }> {
  const lines = text.split(/\r?\n/);
  const chunks: Array<{ content: string; startLine: number; endLine: number }> = [];
  let buffer: string[] = [];
  let startLine = 1;
  let currentChars = 0;

  lines.forEach((line, index) => {
    const nextChars = currentChars + line.length + 1;
    if (buffer.length > 0 && nextChars > chunkChars) {
      chunks.push({
        content: buffer.join('\n'),
        startLine,
        endLine: startLine + buffer.length - 1
      });
      buffer = [];
      currentChars = 0;
      startLine = index + 1;
    }
    buffer.push(line);
    currentChars += line.length + 1;
  });

  if (buffer.length > 0) {
    chunks.push({
      content: buffer.join('\n'),
      startLine,
      endLine: startLine + buffer.length - 1
    });
  }

  return chunks;
}

function getLatestMtime(rootPath: string, filesList: string[]): number {
  let latest = 0;
  for (const file of filesList) {
    const fullPath = path.join(rootPath, file);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && stat.mtimeMs > latest) {
        latest = stat.mtimeMs;
      }
    } catch {
      continue;
    }
  }
  return latest;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function getIndexPath(rootPath: string): string {
  return path.join(rootPath, '.forge', 'embeddings.json');
}
