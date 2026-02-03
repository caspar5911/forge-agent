/** File update orchestration for single- and multi-file edits. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { harvestContext } from '../context';
import type { ChatMessage } from '../llm/client';
import { callChatCompletion } from '../llm/client';
import { getWorkspaceIndex } from '../indexer/workspaceIndex';
import { buildInlineDiffPreview, getLineChangeSummary } from './diff';
import { extractJsonPayload } from './json';
import { isAbortError, logOutput, logVerbose } from './logging';
import { mergeChatHistory } from './intent';
import { listWorkspaceFiles } from './workspaceFiles';
import { extractExplicitPaths, extractKeywords, extractMentionedFiles, findFilesByKeywords } from './fileSearch';
import type { ChatHistoryItem, FileSelectionRequester, FileUpdate } from './types';
import type { ForgeUiApi } from '../ui/api';

let lastManualSelection: string[] = [];
const DEFAULT_MAX_FILES_PER_UPDATE = 6;
const DEFAULT_MAX_UPDATE_CHARS = 60000;
const MAX_JSON_RETRIES = 3;

/** Request a full-file update for a single file from the LLM. */
export async function requestSingleFileUpdate(
  fullPath: string,
  relativePath: string,
  instruction: string,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  history?: ChatHistoryItem[],
  signal?: AbortSignal
): Promise<FileUpdate | null> {
  let originalContent: string;
  try {
    originalContent = fs.readFileSync(fullPath, 'utf8');
  } catch (error) {
    logOutput(output, panelApi, `Error reading file: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: Failed to read the active file.');
    return null;
  }

  logVerbose(output, panelApi, 'Requesting updated file from the local LLM...');
  panelApi?.setStatus('Requesting LLM...');
  const messages = mergeChatHistory(
    history,
    buildFullFileMessages(instruction, relativePath, originalContent)
  );

  let updatedContent: string;
  try {
    const response = await callChatCompletion({}, messages, signal);
    updatedContent = extractUpdatedFile(response);
  } catch (error) {
    if (isAbortError(error)) {
      logOutput(output, panelApi, 'LLM request aborted.');
      return null;
    }
    logOutput(output, panelApi, `LLM error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: LLM request failed.');
    return null;
  }

  if (updatedContent === originalContent) {
    return null;
  }

  return {
    fullPath,
    relativePath,
    original: originalContent,
    updated: updatedContent
  };
}

/** Request file selection and updates for multi-file instructions. */
export async function requestMultiFileUpdate(
  rootPath: string,
  instruction: string,
  activeRelativePath: string | null,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  panel?: FileSelectionRequester | null,
  viewProvider?: FileSelectionRequester | null,
  history?: ChatHistoryItem[],
  extraContext?: string,
  signal?: AbortSignal
): Promise<FileUpdate[] | null> {
  const config = vscode.workspace.getConfiguration('forge');
  const skipCreateFilePicker = config.get<boolean>('skipCreateFilePicker') === true;
  const allowNewFiles = shouldAllowNewFiles(instruction);
  const explicitPaths = extractExplicitPaths(instruction);
  const contextObject = harvestContext();
  const filesList = contextObject.files && contextObject.files.length > 0
    ? contextObject.files
    : listWorkspaceFiles(rootPath, 6, 2000);
  if (filesList.length === 0 && !allowNewFiles && explicitPaths.length === 0) {
    logOutput(output, panelApi, 'No files found in workspace.');
    return null;
  }

  const suggestedFiles = suggestFilesForInstruction(
    instruction,
    filesList,
    getWorkspaceIndex()
  );
  const preselected = lastManualSelection.length > 0 ? lastManualSelection : suggestedFiles;
  const mentionedFiles = extractMentionedFiles(instruction, filesList);
  const directFiles = Array.from(new Set([...mentionedFiles, ...explicitPaths]));
  const isSmallEdit = isSmallEditInstruction(instruction);
  const autoSelectedFiles =
    directFiles.length > 0
      ? directFiles
      : isSmallEdit && suggestedFiles.length === 1
        ? suggestedFiles
        : [];
  const shouldSkipPicker = allowNewFiles && skipCreateFilePicker;
  const shouldOfferPicker =
    !shouldSkipPicker && autoSelectedFiles.length === 0 && suggestedFiles.length > 1;

  if (autoSelectedFiles.length > 0) {
    return buildUpdatesFromUserSelection(
      autoSelectedFiles,
      rootPath,
      instruction,
      activeRelativePath,
      output,
      panelApi,
      extraContext,
      history,
      signal
    );
  }

  if (shouldOfferPicker) {
    const userSelection = await requestUserFileSelection(filesList, preselected, panel, viewProvider);
    if (userSelection) {
      if (userSelection.cancelled) {
        logOutput(output, panelApi, 'File selection cancelled.');
        return null;
      }
      if (userSelection.files.length > 0) {
        lastManualSelection = userSelection.files;
        return buildUpdatesFromUserSelection(
          userSelection.files,
          rootPath,
          instruction,
          activeRelativePath,
          output,
          panelApi,
          extraContext,
          history,
          signal
        );
      }
      if (!allowNewFiles) {
        logOutput(
          output,
          panelApi,
          'No files selected. Please specify which files to edit or provide more context.'
        );
        return null;
      }
    }
  }

  logVerbose(output, panelApi, 'Requesting file selection from the local LLM...');
  panelApi?.setStatus('Selecting files...');
  const selectionMessages = mergeChatHistory(
    history,
    buildFileSelectionMessages(
      instruction,
      filesList,
      activeRelativePath,
      extraContext,
      getWorkspaceIndex(),
      allowNewFiles
    )
  );

  let selectedFiles: string[];
  try {
    const payload = await requestJsonPayloadWithRetries(
      selectionMessages,
      output,
      panelApi,
      signal,
      'selection'
    );
    selectedFiles = Array.isArray(payload.files) ? payload.files : [];
    logVerbose(output, panelApi, `LLM selected files: ${selectedFiles.join(', ') || '(none)'}`);
  } catch (error) {
    if (isAbortError(error)) {
      logOutput(output, panelApi, 'LLM request aborted.');
      return null;
    }
    logOutput(output, panelApi, `LLM error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: LLM file selection failed.');
    return null;
  }

  const uniquePaths = Array.from(
    new Set([...selectedFiles.map((item) => String(item)), ...mentionedFiles, ...explicitPaths])
  );

  if (uniquePaths.length === 0) {
    const keywordMatches = await findFilesByKeywords(instruction, rootPath, filesList);
    uniquePaths.push(...keywordMatches);
  }

  if (uniquePaths.length === 0 && activeRelativePath) {
    uniquePaths.push(activeRelativePath);
  }

  const resolved = uniquePaths
    .map((candidate) => resolveWorkspacePath(rootPath, candidate))
    .filter((item): item is { fullPath: string; relativePath: string } => item !== null);

  if (resolved.length === 0) {
    logOutput(output, panelApi, 'No valid files selected by LLM.');
    return null;
  }
  logOutput(output, panelApi, `Selected files: ${resolved.map((file) => file.relativePath).join(', ')}`);

  const filePayloads = resolved.map((entry) => ({
    path: entry.relativePath,
    content: fs.existsSync(entry.fullPath) ? fs.readFileSync(entry.fullPath, 'utf8') : ''
  }));

  logVerbose(output, panelApi, 'Requesting updated files from the local LLM...');
  let updates: Array<{ path: string; content: string }>;
  try {
    updates = await requestUpdatesInChunks(
      instruction,
      filePayloads,
      activeRelativePath,
      extraContext,
      output,
      panelApi,
      history,
      signal,
      config
    );
  } catch (error) {
    if (isAbortError(error)) {
      logOutput(output, panelApi, 'LLM request aborted.');
      return null;
    }
    logOutput(output, panelApi, `LLM error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: LLM update failed.');
    return null;
  }

  const updateMap = new Map<string, string>();
  for (const item of updates) {
    if (!item || typeof item.path !== 'string' || typeof item.content !== 'string') {
      continue;
    }
    updateMap.set(normalizePathForMatch(item.path), item.content);
  }

  const result: FileUpdate[] = [];
  for (const entry of resolved) {
    const matchKey = normalizePathForMatch(entry.relativePath);
    if (!updateMap.has(matchKey)) {
      logOutput(output, panelApi, `No update returned for ${entry.relativePath}`);
      continue;
    }
    const updated = updateMap.get(matchKey) ?? '';
    const original = fs.existsSync(entry.fullPath) ? fs.readFileSync(entry.fullPath, 'utf8') : '';
    if (updated === original) {
      logOutput(output, panelApi, `No content change for ${entry.relativePath}`);
      continue;
    }
    result.push({
      fullPath: entry.fullPath,
      relativePath: entry.relativePath,
      original,
      updated
    });
  }

  return result;
}

/** Write updated file contents to disk and report success/failure. */
export function applyFileUpdates(
  updates: FileUpdate[],
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi
): boolean {
  try {
    updates.forEach((file) => {
      fs.mkdirSync(path.dirname(file.fullPath), { recursive: true });
      fs.writeFileSync(file.fullPath, file.updated, 'utf8');
    });
    void vscode.window.showInformationMessage(`Forge: Changes applied (${updates.length} files).`);
    return true;
  } catch (error) {
    logOutput(output, panelApi, `Write error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: Failed to write files.');
    return false;
  }
}

/** Run an auto-fix loop using validation output as extra context. */
export async function attemptAutoFix(
  rootPath: string,
  instruction: string,
  validationOutput: string,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  history?: ChatHistoryItem[],
  signal?: AbortSignal
): Promise<boolean> {
  const fixInstruction =
    'Fix the validation errors based on the output below. ' +
    'Only change files necessary to make validation pass.';

  const updates = await requestMultiFileUpdate(
    rootPath,
    `${instruction}\n\n${fixInstruction}`,
    null,
    output,
    panelApi,
    null,
    null,
    history,
    validationOutput,
    signal
  );

  if (!updates || updates.length === 0) {
    logOutput(output, panelApi, 'Auto-fix produced no changes.');
    return false;
  }

  updates.forEach((file) => {
    const summary = getLineChangeSummary(file.original, file.updated, file.relativePath);
    if (summary) {
      logOutput(output, panelApi, summary);
    }
    const inlineDiff = buildInlineDiffPreview(file.original, file.updated, file.relativePath);
    if (inlineDiff && panelApi) {
      panelApi.appendDiff(inlineDiff);
    }
  });

  return applyFileUpdates(updates, output, panelApi);
}

/** Extract updated file content from an LLM response, rejecting diffs. */
function extractUpdatedFile(response: { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }): string {
  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) {
    const errorMessage = response.error?.message ?? 'No content returned by LLM.';
    throw new Error(errorMessage);
  }

  const fenced = content.match(/```(?:\w+)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : content;

  if (isLikelyDiff(raw)) {
    throw new Error('LLM output appears to be a diff, not full file content.');
  }

  return raw;
}

/** Heuristic: detect a unified diff payload. */
function isLikelyDiff(text: string): boolean {
  return text.includes('--- ') && text.includes('+++ ') && text.includes('@@');
}

/** Build the prompt for a single-file full-content update. */
function buildFullFileMessages(
  instruction: string,
  relativePath: string,
  originalContent: string
): ChatMessage[] {
  const commentStyle = shouldAllowComments(instruction)
    ? 'If you add comments, they must be on their own line above the code. Do not add inline trailing comments.'
    : 'Do not add comments unless explicitly requested.';

  return [
    {
      role: 'system',
      content:
        'You are a coding assistant. Return ONLY the full updated content of the target file. ' +
        'Do not include explanations, code fences, or extra text. ' +
        'Preserve unrelated lines and formatting unless changes are required by the instruction. ' +
        commentStyle
    },
    {
      role: 'user',
      content:
        `Instruction: ${instruction}\n` +
        `Target file: ${relativePath}\n` +
        'Current file content:\n' +
        '---\n' +
        `${originalContent}\n` +
        '---\n' +
        'Return the full updated file content only.'
    }
  ];
}

/** Decide whether to allow comment additions based on the instruction. */
function shouldAllowComments(instruction: string): boolean {
  return /\b(comment|comments|document|documentation|explain|explanation)\b/i.test(instruction);
}

/** Decide whether to allow creating new files based on the instruction. */
function shouldAllowNewFiles(instruction: string): boolean {
  return /\b(create|add|new|generate|scaffold|bootstrap|website|web\s*page|html|css)\b/i.test(instruction);
}

/** Heuristic: detect small, localized edits that likely target a single file. */
function isSmallEditInstruction(instruction: string): boolean {
  return /\b(typo|spelling|format|reformat|lint|cleanup|minor|small|simple|rename|comment|docs?)\b/i.test(instruction);
}

/** Resolve and validate a workspace-relative file path. */
function resolveWorkspacePath(
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
  return { fullPath, relativePath };
}

/** Normalize paths for case-insensitive matching. */
function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

/** Build the prompt for selecting files relevant to the instruction. */
function buildFileSelectionMessages(
  instruction: string,
  filesList: string[],
  activeRelativePath: string | null,
  extraContext?: string,
  index?: {
    generatedAt: string;
    symbols: Array<{ name: string; kind: string; containerName: string | null; relativePath: string }>;
    files: string[];
  } | null,
  allowNewFiles?: boolean
): ChatMessage[] {
  const listPreview = filesList.slice(0, 500).join('\n');
  const truncated = filesList.length > 500 ? '\n...(truncated)' : '';
  const contextNote = extraContext ? `\nValidation output:\n${extraContext}\n` : '';
  const activeNote = activeRelativePath ? `Active file: ${activeRelativePath}\n` : '';
  const symbolLines = index?.symbols
    ? index.symbols.slice(0, 250).map((symbol) => {
        const container = symbol.containerName ? ` (${symbol.containerName})` : '';
        return `${symbol.name}${container} | ${symbol.kind} | ${symbol.relativePath}`;
      })
    : [];
  const symbolPreview = symbolLines.length > 0 ? symbolLines.join('\n') : '';
  const symbolTruncated =
    index && index.symbols.length > 250 ? '\n...(more symbols)' : '';
  const symbolBlock = symbolPreview
    ? `Workspace symbols (index @ ${index?.generatedAt ?? 'unknown'}):\n${symbolPreview}${symbolTruncated}\n`
    : '';
  const newFileNote = allowNewFiles
    ? 'If the instruction requires creating new files, you may include new relative paths not in the list.'
    : '';

  return [
    {
      role: 'system',
      content:
        'You are a coding assistant. Select the files that must be edited. ' +
        'Return ONLY valid JSON in the format {"files":["path1","path2"]}. ' +
        'Paths must be relative to the project root. ' +
        newFileNote
    },
    {
      role: 'user',
      content:
        `Instruction: ${instruction}\n` +
        activeNote +
        contextNote +
        symbolBlock +
        'Available files:\n' +
        listPreview +
        truncated +
        '\nReturn JSON only.'
    }
  ];
}

/** Build the prompt for multi-file full-content updates. */
function buildMultiFileUpdateMessages(
  instruction: string,
  files: Array<{ path: string; content: string }>,
  activeRelativePath: string | null,
  extraContext?: string
): ChatMessage[] {
  const filesPayload = files.map((file) => ({
    path: file.path,
    content: file.content
  }));
  const activeNote = activeRelativePath ? `Active file: ${activeRelativePath}\n` : '';
  const contextNote = extraContext ? `\nValidation output:\n${extraContext}\n` : '';

  return [
    {
      role: 'system',
      content:
        'You are a coding assistant. Update the given files to satisfy the instruction. ' +
        'Return ONLY valid JSON in the format {"files":[{"path":"...","content":"..."}]}. ' +
        'Do not include code fences or explanations. Return full file contents.'
    },
    {
      role: 'user',
      content:
        `Instruction: ${instruction}\n` +
        activeNote +
        contextNote +
        'Files:\n' +
        JSON.stringify(filesPayload, null, 2) +
        '\nReturn JSON only.'
    }
  ];
}

/** Ask the UI (panel or view) to choose files before invoking the LLM. */
async function requestUserFileSelection(
  filesList: string[],
  preselected: string[],
  panel?: FileSelectionRequester | null,
  viewProvider?: FileSelectionRequester | null
): Promise<{ files: string[]; cancelled: boolean } | null> {
  if (panel) {
    return panel.requestFileSelection(filesList, preselected);
  }
  if (viewProvider) {
    return viewProvider.requestFileSelection(filesList, preselected);
  }
  return null;
}

/** Generate file updates based on a user-selected file list. */
async function buildUpdatesFromUserSelection(
  selectedFiles: string[],
  rootPath: string,
  instruction: string,
  activeRelativePath: string | null,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  extraContext?: string,
  history?: ChatHistoryItem[],
  signal?: AbortSignal
): Promise<FileUpdate[] | null> {
  const resolved = selectedFiles
    .map((candidate) => resolveWorkspacePath(rootPath, candidate))
    .filter((item): item is { fullPath: string; relativePath: string } => item !== null);

  if (resolved.length === 0) {
    logOutput(output, panelApi, 'No valid files selected.');
    return null;
  }

  const filePayloads = resolved.map((entry) => ({
    path: entry.relativePath,
    content: fs.existsSync(entry.fullPath) ? fs.readFileSync(entry.fullPath, 'utf8') : ''
  }));

  logOutput(output, panelApi, 'Requesting updated files from the local LLM...');
  let updates: Array<{ path: string; content: string }>;
  try {
    const config = vscode.workspace.getConfiguration('forge');
    updates = await requestUpdatesInChunks(
      instruction,
      filePayloads,
      activeRelativePath,
      extraContext,
      output,
      panelApi,
      history,
      signal,
      config
    );
  } catch (error) {
    if (isAbortError(error)) {
      logOutput(output, panelApi, 'LLM request aborted.');
      return null;
    }
    logOutput(output, panelApi, `LLM error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: LLM update failed.');
    return null;
  }

  const updateMap = new Map<string, string>();
  for (const item of updates) {
    if (!item || typeof item.path !== 'string' || typeof item.content !== 'string') {
      continue;
    }
    updateMap.set(normalizePathForMatch(item.path), item.content);
  }

  const result: FileUpdate[] = [];
  for (const entry of resolved) {
    const matchKey = normalizePathForMatch(entry.relativePath);
    if (!updateMap.has(matchKey)) {
      logOutput(output, panelApi, `No update returned for ${entry.relativePath}`);
      continue;
    }
    const updated = updateMap.get(matchKey) ?? '';
    const original = fs.existsSync(entry.fullPath) ? fs.readFileSync(entry.fullPath, 'utf8') : '';
    if (updated === original) {
      logOutput(output, panelApi, `No content change for ${entry.relativePath}`);
      continue;
    }
    result.push({
      fullPath: entry.fullPath,
      relativePath: entry.relativePath,
      original,
      updated
    });
  }

  return result;
}

/** Suggest candidate files based on instruction keywords and symbol index. */
function suggestFilesForInstruction(
  instruction: string,
  filesList: string[],
  index: { symbols: Array<{ name: string; relativePath: string }>; generatedAt: string; files: string[] } | null
): string[] {
  const mentioned = extractMentionedFiles(instruction, filesList);
  const suggestions = new Set<string>(mentioned);
  const keywords = extractKeywords(instruction);

  if (index?.symbols) {
    for (const symbol of index.symbols) {
      const name = symbol.name.toLowerCase();
      if (keywords.some((keyword) => name.includes(keyword.toLowerCase()))) {
        suggestions.add(symbol.relativePath);
      }
      if (instruction.toLowerCase().includes(name)) {
        suggestions.add(symbol.relativePath);
      }
    }
  }

  if (suggestions.size === 0 && keywords.length > 0) {
    for (const file of filesList) {
      const lower = file.toLowerCase();
      if (keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) {
        suggestions.add(file);
      }
      if (suggestions.size >= 12) {
        break;
      }
    }
  }

  return Array.from(suggestions).slice(0, 12);
}

type JsonRetryMode = 'selection' | 'update';

/** Request a JSON payload with multiple retry passes and increasingly strict prompts. */
async function requestJsonPayloadWithRetries(
  messages: ChatMessage[],
  output: vscode.OutputChannel,
  panelApi: ForgeUiApi | undefined,
  signal: AbortSignal | undefined,
  mode: JsonRetryMode,
  maxRetries: number = MAX_JSON_RETRIES
): Promise<{ files?: unknown }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptMessages = buildJsonRetryMessages(messages, attempt, mode);
    try {
      const response = await callChatCompletion({}, attemptMessages, signal);
      return extractJsonPayload(response);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt === 0) {
        logOutput(output, panelApi, `LLM error: ${String(error)}`);
      } else {
        logVerbose(output, panelApi, `LLM error (retry ${attempt}/${maxRetries}): ${String(error)}`);
      }
      if (attempt < maxRetries) {
        logVerbose(output, panelApi, `Retrying with stricter JSON request (${attempt + 1}/${maxRetries})...`);
      }
    }
  }
  throw lastError ?? new Error('LLM JSON retries exhausted.');
}

/** Request updates in chunks to keep LLM output sizes manageable. */
async function requestUpdatesInChunks(
  instruction: string,
  filePayloads: Array<{ path: string; content: string }>,
  activeRelativePath: string | null,
  extraContext: string | undefined,
  output: vscode.OutputChannel,
  panelApi: ForgeUiApi | undefined,
  history: ChatHistoryItem[] | undefined,
  signal: AbortSignal | undefined,
  config: vscode.WorkspaceConfiguration
): Promise<Array<{ path: string; content: string }>> {
  const { maxFiles, maxChars } = getUpdateChunkLimits(config);
  const chunks = chunkFilePayloads(filePayloads, maxFiles, maxChars);
  if (chunks.length > 1) {
    logVerbose(output, panelApi, `Chunking update into ${chunks.length} batches.`);
  }

  const updates: Array<{ path: string; content: string }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const label = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : '';
    panelApi?.setStatus(`Requesting LLM${label}...`);
    const updateMessages = mergeChatHistory(
      history,
      buildMultiFileUpdateMessages(
        instruction,
        chunk,
        activeRelativePath,
        extraContext
      )
    );
    const payload = await requestJsonPayloadWithRetries(
      updateMessages,
      output,
      panelApi,
      signal,
      'update'
    );
    const chunkUpdates = Array.isArray(payload.files) ? payload.files : [];
    logVerbose(output, panelApi, `LLM returned updates for ${chunkUpdates.length} files${label}.`);
    updates.push(...chunkUpdates);
  }

  return updates;
}

/** Compute chunking limits for multi-file update requests. */
function getUpdateChunkLimits(config: vscode.WorkspaceConfiguration): { maxFiles: number; maxChars: number } {
  const configuredMaxFiles = config.get<number>('maxFilesPerUpdate');
  const configuredMaxChars = config.get<number>('maxUpdateChars');
  const maxFiles = Math.max(1, configuredMaxFiles ?? DEFAULT_MAX_FILES_PER_UPDATE);
  const maxChars = Math.max(1000, configuredMaxChars ?? DEFAULT_MAX_UPDATE_CHARS);
  return { maxFiles, maxChars };
}

/** Split file payloads into chunks based on file count and estimated JSON size. */
function chunkFilePayloads(
  files: Array<{ path: string; content: string }>,
  maxFiles: number,
  maxChars: number
): Array<Array<{ path: string; content: string }>> {
  if (files.length === 0) {
    return [];
  }

  const chunks: Array<Array<{ path: string; content: string }>> = [];
  let current: Array<{ path: string; content: string }> = [];
  let currentChars = 0;

  for (const file of files) {
    const estimated = estimatePayloadChars(file);
    const wouldExceedFiles = current.length >= maxFiles;
    const wouldExceedChars = current.length > 0 && currentChars + estimated > maxChars;

    if (wouldExceedFiles || wouldExceedChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(file);
    currentChars += estimated;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

/** Estimate the JSON payload size for a single file entry. */
function estimatePayloadChars(file: { path: string; content: string }): number {
  return JSON.stringify(file).length;
}

/** Build retry messages with increasing JSON strictness. */
function buildJsonRetryMessages(
  messages: ChatMessage[],
  attempt: number,
  mode: JsonRetryMode
): ChatMessage[] {
  if (attempt <= 0) {
    return messages;
  }
  if (attempt === 1) {
    return buildStrictJsonRetryMessages(messages, mode);
  }
  if (attempt === 2) {
    return buildVeryStrictJsonRetryMessages(messages, mode);
  }
  return buildMaxStrictJsonRetryMessages(messages, mode);
}

function getSchemaHint(mode: JsonRetryMode): string {
  return mode === 'selection'
    ? '{"files":["path1","path2"]}'
    : '{"files":[{"path":"...","content":"..."}]}';
}

/** Wrap an existing prompt with a strict JSON-only system instruction. */
function buildStrictJsonRetryMessages(messages: ChatMessage[], mode: JsonRetryMode): ChatMessage[] {
  const strictSystem: ChatMessage = {
    role: 'system',
    content:
      'Return ONLY valid JSON with the exact schema ' + getSchemaHint(mode) + '. ' +
      'Do not include code fences, trailing commas, or extra text.'
  };
  return [strictSystem, ...messages];
}

/** Wrap with stricter JSON guidance, emphasizing escaping. */
function buildVeryStrictJsonRetryMessages(messages: ChatMessage[], mode: JsonRetryMode): ChatMessage[] {
  const strictSystem: ChatMessage = {
    role: 'system',
    content:
      'Return ONLY JSON. The response must be parseable by JSON.parse. ' +
      'Use the exact schema ' + getSchemaHint(mode) + '. ' +
      'Escape all newlines as \\n and all quotes inside strings as \\". ' +
      'No code fences, no comments, no markdown.'
  };
  return [strictSystem, ...messages];
}

/** Final retry message with maximum strictness. */
function buildMaxStrictJsonRetryMessages(messages: ChatMessage[], mode: JsonRetryMode): ChatMessage[] {
  const strictSystem: ChatMessage = {
    role: 'system',
    content:
      'Output ONLY minified JSON with the exact schema ' + getSchemaHint(mode) + '. ' +
      'No whitespace outside strings. No extra keys. ' +
      'All newline characters inside strings must be escaped as \\n. ' +
      'If unsure, return {"files":[]} only.'
  };
  return [strictSystem, ...messages];
}
