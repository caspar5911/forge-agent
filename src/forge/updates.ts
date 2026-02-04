/** File update orchestration for single- and multi-file edits. */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { harvestContext } from '../context';
import type { ChatMessage } from '../llm/client';
import { callChatCompletion } from '../llm/client';
import { getWorkspaceIndex } from '../indexer/workspaceIndex';
import { buildInlineDiffPreview, getLineChangeSummary } from './diff';
import { FILE_SELECTION_SCHEMA, FILE_UPDATE_SCHEMA } from './schemas';
import { isAbortError, logOutput, logVerbose } from './logging';
import { mergeChatHistory } from './intent';
import { listWorkspaceFiles } from './workspaceFiles';
import { extractExplicitPaths, extractKeywords, extractMentionedFiles } from './fileSearch';
import { getForgeSetting } from './settings';
import { recordPayload, recordPrompt, recordResponse, recordStep } from './trace';
import type { ChatHistoryItem, FileSelectionRequester, FileUpdate } from './types';
import type { ForgeUiApi } from '../ui/api';
import { computeAutoSelection, resolveSelectionCandidates, resolveWorkspacePath } from './updateSelection';
import { runCommand } from '../validation';
import { requestStructuredJson } from '../llm/structured';

let lastManualSelection: string[] = [];
let installApprovedOnce = false;
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
  extraContext?: string,
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
    buildFullFileMessages(instruction, relativePath, originalContent, extraContext)
  );
  recordPrompt(`Edit prompt (single): ${relativePath}`, messages, true);

  let updatedContent: string;
  try {
    const response = await callChatCompletion({}, messages, signal);
    updatedContent = extractUpdatedFile(response);
    recordResponse(`Edit response (single): ${relativePath}`, updatedContent);
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
  signal?: AbortSignal,
  scaffoldTypeOverride?: ScaffoldType
): Promise<FileUpdate[] | null> {
  const skipCreateFilePicker = getForgeSetting<boolean>('skipCreateFilePicker') === true;
  const bestEffortFix = getForgeSetting<boolean>('bestEffortFix') === true;
  const autoAddDependencies = getForgeSetting<boolean>('autoAddDependencies') === true;
  const autoCreateMissingFiles = getForgeSetting<boolean>('autoCreateMissingFiles') === true;
  const fixHints = bestEffortFix ? collectFixHints(extraContext, rootPath) : { missingModules: [], missingFiles: [] };
  const hintFiles: string[] = [];
  if (autoAddDependencies && fixHints.missingModules.length > 0) {
    hintFiles.push('package.json');
  }
  const hintNewFiles = autoCreateMissingFiles ? fixHints.missingFiles : [];
  const allowNewFiles = shouldAllowNewFiles(instruction) || hintNewFiles.length > 0;
  const explicitPathsRaw = Array.from(new Set([...extractExplicitPaths(instruction), ...hintNewFiles]));
  if (fixHints.missingModules.length > 0) {
    recordStep('Fix hints', `Missing modules: ${fixHints.missingModules.join(', ')}`);
  }
  if (fixHints.missingFiles.length > 0) {
    recordStep('Fix hints', `Missing files: ${fixHints.missingFiles.join(', ')}`);
  }
  if (autoAddDependencies && fixHints.missingModules.length > 0) {
    instruction += `\n\nMissing dependencies detected: ${fixHints.missingModules.join(', ')}. Add them to package.json.`;
  }
  if (autoCreateMissingFiles && fixHints.missingFiles.length > 0) {
    instruction += `\n\nMissing relative files detected: ${fixHints.missingFiles.join(', ')}. Create these files as needed.`;
  }
  const contextObject = harvestContext();
  let filesList = contextObject.files && contextObject.files.length > 0
    ? contextObject.files
    : listWorkspaceFiles(rootPath, 6, 2000);
  if (fs.existsSync(path.join(rootPath, 'package.json')) && !filesList.includes('package.json')) {
    filesList.push('package.json');
  }
  const projectSubdir = detectProjectSubdir(filesList);
  if (projectSubdir) {
    recordStep('Project root hint', projectSubdir);
  }
  const mapToProjectRoot = (value: string) => applyProjectSubdir(value, projectSubdir);
  const explicitPaths = explicitPathsRaw.map(mapToProjectRoot);
  const mappedHintFiles = hintFiles.map(mapToProjectRoot);
  const scaffold = maybeCreateScaffold(
    rootPath,
    instruction,
    allowNewFiles,
    filesList,
    output,
    panelApi,
    scaffoldTypeOverride
  );
  if (scaffold) {
    filesList = listWorkspaceFiles(rootPath, 6, 2000);
    scaffold.files.forEach((file) => {
      if (!filesList.includes(file)) {
        filesList.push(file);
      }
    });
    recordStep('Scaffold', `${scaffold.type}\n${scaffold.files.join('\n')}`);
  }
  if (filesList.length === 0 && !allowNewFiles && explicitPaths.length === 0) {
    logOutput(output, panelApi, 'No files found in workspace.');
    return null;
  }

  const suggestedFiles = suggestFilesForInstruction(instruction, filesList, getWorkspaceIndex());
  const preselected = lastManualSelection.length > 0 ? lastManualSelection : suggestedFiles;
  const mentionedFiles = extractMentionedFiles(instruction, filesList).map(mapToProjectRoot);
  const directFiles = Array.from(new Set([...mentionedFiles, ...explicitPaths, ...mappedHintFiles]));
  const autoSelection = computeAutoSelection({
    directFiles,
    filesList,
    suggestedFiles,
    allowNewFiles,
    skipCreateFilePicker,
    instruction
  });

  if (autoSelection.autoSelectedFiles.length > 0) {
    recordStep('File selection (auto)', autoSelection.autoSelectedFiles.join('\n'));
    return buildUpdatesFromUserSelection(
      autoSelection.autoSelectedFiles,
      rootPath,
      instruction,
      activeRelativePath,
      output,
      panelApi,
      extraContext,
      history,
      signal,
      projectSubdir
    );
  }

  if (autoSelection.shouldOfferPicker) {
    const userSelection = await requestUserFileSelection(filesList, preselected, panel, viewProvider);
    if (userSelection) {
      if (userSelection.cancelled) {
        logOutput(output, panelApi, 'File selection cancelled.');
        return null;
      }
      if (userSelection.files.length > 0) {
        recordStep('File selection (manual)', userSelection.files.join('\n'));
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
          signal,
          projectSubdir
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
      'selection',
      'File selection'
    );
    recordPayload('File selection JSON', JSON.stringify(payload, null, 2));
    selectedFiles = Array.isArray(payload.files) ? payload.files.map(mapToProjectRoot) : [];
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

  const candidatePaths = await resolveSelectionCandidates({
    selectedFiles,
    mentionedFiles,
    explicitPaths,
    filesList,
    rootPath,
    activeRelativePath,
    instruction
  });

  const resolved = candidatePaths
    .map((candidate) => resolveWorkspacePath(rootPath, candidate))
    .filter((item): item is { fullPath: string; relativePath: string } => item !== null);

  if (resolved.length === 0) {
    logOutput(output, panelApi, 'No valid files selected by LLM.');
    return null;
  }
  logOutput(output, panelApi, `Selected files: ${resolved.map((file) => file.relativePath).join(', ')}`);
  recordStep('Selected files', resolved.map((file) => file.relativePath).join('\n'));

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
      signal
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
  signal?: AbortSignal,
  extraFixContext?: string
): Promise<FileUpdate[] | null> {
  const fixInstruction =
    'Fix the validation errors based on the output below. ' +
    'Only change files necessary to make validation pass.';

  const extraContext = extraFixContext
    ? `${validationOutput}\n\nAdditional fix context:\n${extraFixContext}`
    : validationOutput;

  const updates = await requestMultiFileUpdate(
    rootPath,
    `${instruction}\n\n${fixInstruction}`,
    null,
    output,
    panelApi,
    null,
    null,
    history,
    extraContext,
    signal,
    undefined
  );

  if (!updates || updates.length === 0) {
    logOutput(output, panelApi, 'Auto-fix produced no changes.');
    return null;
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

  const applied = applyFileUpdates(updates, output, panelApi);
  if (!applied) {
    return null;
  }

  const autoInstall = getForgeSetting<boolean>('autoInstallDependencies') === true;
  const updatedPackageJson = updates.some((file) => normalizePathForMatch(file.relativePath) === 'package.json');
  if (autoInstall && updatedPackageJson) {
    const skipConfirmations = getForgeSetting<boolean>('skipConfirmations') === true;
    let shouldRun = skipConfirmations || installApprovedOnce;
    if (!skipConfirmations) {
      if (!installApprovedOnce) {
        const confirm = await vscode.window.showWarningMessage(
          'package.json changed. Run install to update dependencies?',
          'Run install',
          'Skip'
        );
        shouldRun = confirm === 'Run install';
        if (shouldRun) {
          installApprovedOnce = true;
        }
      }
    }
    if (shouldRun) {
      const context = harvestContext();
      const command = getInstallCommand(rootPath, context.packageManager ?? null);
      recordStep('Dependency install', command);
      logOutput(output, panelApi, `Running install: ${command}`);
      try {
        const result = await runCommand(command, rootPath, output);
        recordStep('Dependency install exit code', String(result.code));
        recordPayload('Dependency install output', result.output || '(no output)');
      } catch (error) {
        recordStep('Dependency install error', String(error));
        logOutput(output, panelApi, `Install error: ${String(error)}`);
      }
    }
  }

  return updates;
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
  originalContent: string,
  extraContext?: string
): ChatMessage[] {
  const commentStyle = shouldAllowComments(instruction)
    ? 'If you add comments, they must be on their own line above the code. Do not add inline trailing comments.'
    : 'Do not add comments unless explicitly requested.';
  const contextNote = extraContext ? `\nAdditional context:\n${extraContext}\n` : '';

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
        contextNote +
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

export type ScaffoldType =
  | 'static'
  | 'react-vite'
  | 'vue-vite'
  | 'svelte-vite'
  | 'nextjs'
  | 'nuxt'
  | 'astro';

export type ScaffoldDecision = {
  type: ScaffoldType;
  source: 'explicit' | 'heuristic' | 'default';
  reason: string;
};

type ScaffoldResult = {
  type: ScaffoldType;
  files: string[];
};

export function decideScaffoldStack(instruction: string, filesList: string[]): ScaffoldDecision | null {
  if (!shouldAllowNewFiles(instruction) || filesList.length > 0) {
    return null;
  }

  const explicit = detectExplicitScaffoldType(instruction);
  if (explicit) {
    return {
      type: explicit,
      source: 'explicit',
      reason: 'Stack mentioned in prompt.'
    };
  }

  if (needsAppFramework(instruction)) {
    return {
      type: 'react-vite',
      source: 'heuristic',
      reason: 'App-level features requested; using React + Vite.'
    };
  }

  return {
    type: 'static',
    source: 'default',
    reason: 'Defaulting to a static site for simple website requests.'
  };
}

function maybeCreateScaffold(
  rootPath: string,
  instruction: string,
  allowNewFiles: boolean,
  filesList: string[],
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  scaffoldTypeOverride?: ScaffoldType
): ScaffoldResult | null {
  if (!allowNewFiles || filesList.length > 0) {
    return null;
  }

  const decision = scaffoldTypeOverride
    ? {
        type: scaffoldTypeOverride,
        source: 'explicit' as const,
        reason: 'Selected before scaffolding.'
      }
    : decideScaffoldStack(instruction, filesList);
  if (!decision) {
    return null;
  }
  const files = createScaffold(rootPath, decision.type);

  if (files.length === 0) {
    return null;
  }

  logOutput(output, panelApi, `Scaffolded ${decision.type} project files.`);
  const showCommands = getForgeSetting<boolean>('showScaffoldCommands') !== false;
  if (showCommands) {
    const commands = getScaffoldCommands(decision.type);
    if (commands.length > 0) {
      logOutput(output, panelApi, 'Manual scaffold commands (optional):');
      commands.forEach((command) => logOutput(output, panelApi, `- ${command}`));
    }
  }
  return { type: decision.type, files };
}

function detectExplicitScaffoldType(instruction: string): ScaffoldType | null {
  const lowered = instruction.toLowerCase();
  if (/\bnext(\.js)?\b/.test(lowered)) {
    return 'nextjs';
  }
  if (/\bnuxt\b/.test(lowered)) {
    return 'nuxt';
  }
  if (/\bvue\b/.test(lowered)) {
    return 'vue-vite';
  }
  if (/\bsvelte\b/.test(lowered)) {
    return 'svelte-vite';
  }
  if (/\bastro\b/.test(lowered)) {
    return 'astro';
  }
  if (/\breact\b/.test(lowered) || /\bvite\b/.test(lowered)) {
    return 'react-vite';
  }
  return null;
}

function needsAppFramework(instruction: string): boolean {
  const lowered = instruction.toLowerCase();
  return /\b(app|dashboard|admin|login|signup|auth|ecommerce|cart|checkout|profile|api|backend|database|router|routing|spa)\b/.test(
    lowered
  );
}

function createScaffold(rootPath: string, type: ScaffoldType): string[] {
  switch (type) {
    case 'react-vite':
      return createReactViteScaffold(rootPath);
    case 'vue-vite':
      return createVueViteScaffold(rootPath);
    case 'svelte-vite':
      return createSvelteViteScaffold(rootPath);
    case 'nextjs':
      return createNextScaffold(rootPath);
    case 'nuxt':
      return createNuxtScaffold(rootPath);
    case 'astro':
      return createAstroScaffold(rootPath);
    case 'static':
    default:
      return createStaticScaffold(rootPath);
  }
}

function getScaffoldCommands(type: ScaffoldType): string[] {
  switch (type) {
    case 'react-vite':
      return [
        'npm create vite@latest my-app -- --template react',
        'cd my-app',
        'npm install',
        'npm run dev'
      ];
    case 'vue-vite':
      return [
        'npm create vite@latest my-app -- --template vue',
        'cd my-app',
        'npm install',
        'npm run dev'
      ];
    case 'svelte-vite':
      return [
        'npm create vite@latest my-app -- --template svelte',
        'cd my-app',
        'npm install',
        'npm run dev'
      ];
    case 'nextjs':
      return [
        'npx create-next-app@latest my-app',
        'cd my-app',
        'npm run dev'
      ];
    case 'nuxt':
      return [
        'npx nuxi@latest init my-app',
        'cd my-app',
        'npm install',
        'npm run dev'
      ];
    case 'astro':
      return [
        'npm create astro@latest my-app',
        'cd my-app',
        'npm install',
        'npm run dev'
      ];
    case 'static':
    default:
      return [
        'Create index.html, styles.css, and main.js in the project root.',
        'Open index.html in a browser or run: npx serve .'
      ];
  }
}

function createStaticScaffold(rootPath: string): string[] {
  const created: string[] = [];
  const files = [
    {
      path: 'index.html',
      content:
        '<!doctype html>\n' +
        '<html lang="en">\n' +
        '<head>\n' +
        '  <meta charset="UTF-8" />\n' +
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
        '  <title>New Website</title>\n' +
        '  <link rel="stylesheet" href="styles.css" />\n' +
        '</head>\n' +
        '<body>\n' +
        '  <div id="app">\n' +
        '    <header>\n' +
        '      <h1>Site Title</h1>\n' +
        '    </header>\n' +
        '    <main>\n' +
        '      <section class="hero">\n' +
        '        <h2>Hero headline</h2>\n' +
        '        <p>Hero copy goes here.</p>\n' +
        '      </section>\n' +
        '    </main>\n' +
        '    <footer>\n' +
        '      <small>Footer text</small>\n' +
        '    </footer>\n' +
        '  </div>\n' +
        '  <script src="main.js"></script>\n' +
        '</body>\n' +
        '</html>\n'
    },
    {
      path: 'styles.css',
      content:
        'body {\n' +
        '  margin: 0;\n' +
        '  font-family: Arial, sans-serif;\n' +
        '  color: #111;\n' +
        '  background: #fff;\n' +
        '}\n' +
        '\n' +
        '#app {\n' +
        '  min-height: 100vh;\n' +
        '  display: flex;\n' +
        '  flex-direction: column;\n' +
        '}\n' +
        '\n' +
        'main {\n' +
        '  flex: 1;\n' +
        '  padding: 40px 20px;\n' +
        '}\n'
    },
    {
      path: 'main.js',
      content: "console.log('Site ready');\n"
    }
  ];

  files.forEach((file) => {
    if (writeFileIfMissing(rootPath, file.path, file.content)) {
      created.push(file.path);
    }
  });

  return created;
}

function detectProjectSubdir(filesList: string[]): string | null {
  if (filesList.length === 0) {
    return null;
  }
  const topLevel = new Set<string>();
  let hasRootFiles = false;

  for (const file of filesList) {
    const normalized = file.replace(/\\/g, '/').replace(/^\.\/+/, '');
    const parts = normalized.split('/');
    if (parts.length === 1) {
      hasRootFiles = true;
      continue;
    }
    if (parts[0]) {
      topLevel.add(parts[0]);
    }
    if (topLevel.size > 1) {
      return null;
    }
  }

  if (hasRootFiles || topLevel.size !== 1) {
    return null;
  }

  return Array.from(topLevel)[0] ?? null;
}

function applyProjectSubdir(candidate: string, projectSubdir: string | null): string {
  if (!projectSubdir) {
    return candidate;
  }
  const normalized = candidate.replace(/\\/g, '/');
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  if (normalized.startsWith(`${projectSubdir}/`)) {
    return candidate;
  }
  if (normalized.startsWith('./') || normalized.startsWith('../')) {
    return candidate;
  }
  return path.join(projectSubdir, candidate);
}

function createReactViteScaffold(rootPath: string): string[] {
  const created: string[] = [];
  const files = [
    {
      path: 'package.json',
      content:
        '{\n' +
        '  "name": "forge-app",\n' +
        '  "private": true,\n' +
        '  "version": "0.0.0",\n' +
        '  "type": "module",\n' +
        '  "scripts": {\n' +
        '    "dev": "vite",\n' +
        '    "build": "vite build",\n' +
        '    "preview": "vite preview"\n' +
        '  },\n' +
        '  "dependencies": {\n' +
        '    "react": "^18.2.0",\n' +
        '    "react-dom": "^18.2.0"\n' +
        '  },\n' +
        '  "devDependencies": {\n' +
        '    "@vitejs/plugin-react": "^4.2.0",\n' +
        '    "vite": "^5.0.0"\n' +
        '  }\n' +
        '}\n'
    },
    {
      path: 'vite.config.js',
      content:
        "import { defineConfig } from 'vite';\n" +
        "import react from '@vitejs/plugin-react';\n" +
        '\n' +
        'export default defineConfig({\n' +
        '  plugins: [react()]\n' +
        '});\n'
    },
    {
      path: 'index.html',
      content:
        '<!doctype html>\n' +
        '<html lang="en">\n' +
        '  <head>\n' +
        '    <meta charset="UTF-8" />\n' +
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
        '    <title>Forge App</title>\n' +
        '  </head>\n' +
        '  <body>\n' +
        '    <div id="root"></div>\n' +
        '    <script type="module" src="/src/main.jsx"></script>\n' +
        '  </body>\n' +
        '</html>\n'
    },
    {
      path: path.join('src', 'main.jsx'),
      content:
        "import React from 'react';\n" +
        "import ReactDOM from 'react-dom/client';\n" +
        "import App from './App.jsx';\n" +
        "import './index.css';\n" +
        '\n' +
        'ReactDOM.createRoot(document.getElementById(\'root\')).render(\n' +
        '  <React.StrictMode>\n' +
        '    <App />\n' +
        '  </React.StrictMode>\n' +
        ');\n'
    },
    {
      path: path.join('src', 'App.jsx'),
      content:
        "import React from 'react';\n" +
        "import './index.css';\n" +
        '\n' +
        'export default function App() {\n' +
        '  return (\n' +
        '    <div className="app">\n' +
        '      <h1>Forge App</h1>\n' +
        '      <p>Update this layout based on the request.</p>\n' +
        '    </div>\n' +
        '  );\n' +
        '}\n'
    },
    {
      path: path.join('src', 'index.css'),
      content:
        'body {\n' +
        '  margin: 0;\n' +
        '  font-family: Arial, sans-serif;\n' +
        '  background: #fff;\n' +
        '  color: #111;\n' +
        '}\n' +
        '\n' +
        '.app {\n' +
        '  padding: 40px 20px;\n' +
        '}\n'
    }
  ];

  files.forEach((file) => {
    if (writeFileIfMissing(rootPath, file.path, file.content)) {
      created.push(file.path);
    }
  });

  return created;
}

function createVueViteScaffold(rootPath: string): string[] {
  const created: string[] = [];
  const files = [
    {
      path: 'package.json',
      content:
        '{\n' +
        '  "name": "forge-vue-app",\n' +
        '  "private": true,\n' +
        '  "version": "0.0.0",\n' +
        '  "type": "module",\n' +
        '  "scripts": {\n' +
        '    "dev": "vite",\n' +
        '    "build": "vite build",\n' +
        '    "preview": "vite preview"\n' +
        '  },\n' +
        '  "dependencies": {\n' +
        '    "vue": "^3.4.0"\n' +
        '  },\n' +
        '  "devDependencies": {\n' +
        '    "@vitejs/plugin-vue": "^5.0.0",\n' +
        '    "vite": "^5.0.0"\n' +
        '  }\n' +
        '}\n'
    },
    {
      path: 'vite.config.js',
      content:
        "import { defineConfig } from 'vite';\n" +
        "import vue from '@vitejs/plugin-vue';\n" +
        '\n' +
        'export default defineConfig({\n' +
        '  plugins: [vue()]\n' +
        '});\n'
    },
    {
      path: 'index.html',
      content:
        '<!doctype html>\n' +
        '<html lang="en">\n' +
        '  <head>\n' +
        '    <meta charset="UTF-8" />\n' +
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
        '    <title>Forge Vue App</title>\n' +
        '  </head>\n' +
        '  <body>\n' +
        '    <div id="app"></div>\n' +
        '    <script type="module" src="/src/main.js"></script>\n' +
        '  </body>\n' +
        '</html>\n'
    },
    {
      path: path.join('src', 'main.js'),
      content:
        "import { createApp } from 'vue';\n" +
        "import App from './App.vue';\n" +
        "import './style.css';\n" +
        '\n' +
        'createApp(App).mount(\'#app\');\n'
    },
    {
      path: path.join('src', 'App.vue'),
      content:
        '<template>\n' +
        '  <div class="app">\n' +
        '    <h1>Forge Vue App</h1>\n' +
        '    <p>Update this layout based on the request.</p>\n' +
        '  </div>\n' +
        '</template>\n' +
        '\n' +
        '<script setup>\n' +
        '</script>\n' +
        '\n' +
        '<style scoped>\n' +
        '.app {\n' +
        '  padding: 40px 20px;\n' +
        '  font-family: Arial, sans-serif;\n' +
        '}\n' +
        '</style>\n'
    },
    {
      path: path.join('src', 'style.css'),
      content:
        'body {\n' +
        '  margin: 0;\n' +
        '  font-family: Arial, sans-serif;\n' +
        '  background: #fff;\n' +
        '  color: #111;\n' +
        '}\n'
    }
  ];

  files.forEach((file) => {
    if (writeFileIfMissing(rootPath, file.path, file.content)) {
      created.push(file.path);
    }
  });

  return created;
}

function createSvelteViteScaffold(rootPath: string): string[] {
  const created: string[] = [];
  const files = [
    {
      path: 'package.json',
      content:
        '{\n' +
        '  "name": "forge-svelte-app",\n' +
        '  "private": true,\n' +
        '  "version": "0.0.0",\n' +
        '  "type": "module",\n' +
        '  "scripts": {\n' +
        '    "dev": "vite",\n' +
        '    "build": "vite build",\n' +
        '    "preview": "vite preview"\n' +
        '  },\n' +
        '  "devDependencies": {\n' +
        '    "@sveltejs/vite-plugin-svelte": "^3.0.0",\n' +
        '    "svelte": "^4.0.0",\n' +
        '    "vite": "^5.0.0"\n' +
        '  }\n' +
        '}\n'
    },
    {
      path: 'vite.config.js',
      content:
        "import { defineConfig } from 'vite';\n" +
        "import { svelte } from '@sveltejs/vite-plugin-svelte';\n" +
        '\n' +
        'export default defineConfig({\n' +
        '  plugins: [svelte()]\n' +
        '});\n'
    },
    {
      path: 'index.html',
      content:
        '<!doctype html>\n' +
        '<html lang="en">\n' +
        '  <head>\n' +
        '    <meta charset="UTF-8" />\n' +
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
        '    <title>Forge Svelte App</title>\n' +
        '  </head>\n' +
        '  <body>\n' +
        '    <div id="app"></div>\n' +
        '    <script type="module" src="/src/main.js"></script>\n' +
        '  </body>\n' +
        '</html>\n'
    },
    {
      path: path.join('src', 'main.js'),
      content:
        "import App from './App.svelte';\n" +
        "import './app.css';\n" +
        '\n' +
        'const app = new App({\n' +
        '  target: document.getElementById(\'app\')\n' +
        '});\n' +
        '\n' +
        'export default app;\n'
    },
    {
      path: path.join('src', 'App.svelte'),
      content:
        '<main class="app">\n' +
        '  <h1>Forge Svelte App</h1>\n' +
        '  <p>Update this layout based on the request.</p>\n' +
        '</main>\n' +
        '\n' +
        '<style>\n' +
        '.app {\n' +
        '  padding: 40px 20px;\n' +
        '  font-family: Arial, sans-serif;\n' +
        '}\n' +
        '</style>\n'
    },
    {
      path: path.join('src', 'app.css'),
      content:
        'body {\n' +
        '  margin: 0;\n' +
        '  font-family: Arial, sans-serif;\n' +
        '  background: #fff;\n' +
        '  color: #111;\n' +
        '}\n'
    }
  ];

  files.forEach((file) => {
    if (writeFileIfMissing(rootPath, file.path, file.content)) {
      created.push(file.path);
    }
  });

  return created;
}

function createNextScaffold(rootPath: string): string[] {
  const created: string[] = [];
  const files = [
    {
      path: 'package.json',
      content:
        '{\n' +
        '  "name": "forge-next-app",\n' +
        '  "private": true,\n' +
        '  "version": "0.0.0",\n' +
        '  "scripts": {\n' +
        '    "dev": "next dev",\n' +
        '    "build": "next build",\n' +
        '    "start": "next start"\n' +
        '  },\n' +
        '  "dependencies": {\n' +
        '    "next": "^14.1.0",\n' +
        '    "react": "^18.2.0",\n' +
        '    "react-dom": "^18.2.0"\n' +
        '  }\n' +
        '}\n'
    },
    {
      path: path.join('pages', '_app.jsx'),
      content:
        "import '../styles/globals.css';\n" +
        '\n' +
        'export default function App({ Component, pageProps }) {\n' +
        '  return <Component {...pageProps} />;\n' +
        '}\n'
    },
    {
      path: path.join('pages', 'index.jsx'),
      content:
        'export default function Home() {\n' +
        '  return (\n' +
        '    <main style={{ padding: \'40px 20px\', fontFamily: \'Arial, sans-serif\' }}>\n' +
        '      <h1>Forge Next.js App</h1>\n' +
        '      <p>Update this layout based on the request.</p>\n' +
        '    </main>\n' +
        '  );\n' +
        '}\n'
    },
    {
      path: path.join('styles', 'globals.css'),
      content:
        'body {\n' +
        '  margin: 0;\n' +
        '  background: #fff;\n' +
        '  color: #111;\n' +
        '}\n'
    }
  ];

  files.forEach((file) => {
    if (writeFileIfMissing(rootPath, file.path, file.content)) {
      created.push(file.path);
    }
  });

  return created;
}

function createNuxtScaffold(rootPath: string): string[] {
  const created: string[] = [];
  const files = [
    {
      path: 'package.json',
      content:
        '{\n' +
        '  "name": "forge-nuxt-app",\n' +
        '  "private": true,\n' +
        '  "version": "0.0.0",\n' +
        '  "type": "module",\n' +
        '  "scripts": {\n' +
        '    "dev": "nuxt dev",\n' +
        '    "build": "nuxt build",\n' +
        '    "preview": "nuxt preview"\n' +
        '  },\n' +
        '  "dependencies": {\n' +
        '    "nuxt": "^3.10.0"\n' +
        '  }\n' +
        '}\n'
    },
    {
      path: 'nuxt.config.ts',
      content:
        'export default defineNuxtConfig({\n' +
        "  css: ['~/assets/main.css']\n" +
        '});\n'
    },
    {
      path: path.join('pages', 'index.vue'),
      content:
        '<template>\n' +
        '  <main class="page">\n' +
        '    <h1>Forge Nuxt App</h1>\n' +
        '    <p>Update this layout based on the request.</p>\n' +
        '  </main>\n' +
        '</template>\n' +
        '\n' +
        '<style scoped>\n' +
        '.page {\n' +
        '  padding: 40px 20px;\n' +
        '  font-family: Arial, sans-serif;\n' +
        '}\n' +
        '</style>\n'
    },
    {
      path: path.join('assets', 'main.css'),
      content:
        'body {\n' +
        '  margin: 0;\n' +
        '  background: #fff;\n' +
        '  color: #111;\n' +
        '}\n'
    }
  ];

  files.forEach((file) => {
    if (writeFileIfMissing(rootPath, file.path, file.content)) {
      created.push(file.path);
    }
  });

  return created;
}

function createAstroScaffold(rootPath: string): string[] {
  const created: string[] = [];
  const files = [
    {
      path: 'package.json',
      content:
        '{\n' +
        '  "name": "forge-astro-site",\n' +
        '  "private": true,\n' +
        '  "version": "0.0.0",\n' +
        '  "type": "module",\n' +
        '  "scripts": {\n' +
        '    "dev": "astro dev",\n' +
        '    "build": "astro build",\n' +
        '    "preview": "astro preview"\n' +
        '  },\n' +
        '  "dependencies": {\n' +
        '    "astro": "^4.0.0"\n' +
        '  }\n' +
        '}\n'
    },
    {
      path: 'astro.config.mjs',
      content:
        "import { defineConfig } from 'astro/config';\n" +
        '\n' +
        'export default defineConfig({});\n'
    },
    {
      path: path.join('src', 'pages', 'index.astro'),
      content:
        '---\n' +
        'const title = \'Forge Astro Site\';\n' +
        '---\n' +
        '<!doctype html>\n' +
        '<html lang="en">\n' +
        '  <head>\n' +
        '    <meta charset="UTF-8" />\n' +
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
        '    <title>{title}</title>\n' +
        '    <link rel="stylesheet" href="/src/styles/global.css" />\n' +
        '  </head>\n' +
        '  <body>\n' +
        '    <main class="page">\n' +
        '      <h1>{title}</h1>\n' +
        '      <p>Update this layout based on the request.</p>\n' +
        '    </main>\n' +
        '  </body>\n' +
        '</html>\n'
    },
    {
      path: path.join('src', 'styles', 'global.css'),
      content:
        'body {\n' +
        '  margin: 0;\n' +
        '  font-family: Arial, sans-serif;\n' +
        '  background: #fff;\n' +
        '  color: #111;\n' +
        '}\n' +
        '\n' +
        '.page {\n' +
        '  padding: 40px 20px;\n' +
        '}\n'
    }
  ];

  files.forEach((file) => {
    if (writeFileIfMissing(rootPath, file.path, file.content)) {
      created.push(file.path);
    }
  });

  return created;
}

function writeFileIfMissing(rootPath: string, relativePath: string, content: string): boolean {
  const fullPath = path.join(rootPath, relativePath);
  if (fs.existsSync(fullPath)) {
    return false;
  }
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return true;
}

type FixHints = {
  missingModules: string[];
  missingFiles: string[];
};

function collectFixHints(extraContext: string | undefined, rootPath: string): FixHints {
  if (!extraContext) {
    return { missingModules: [], missingFiles: [] };
  }
  const imports = extractMissingImports(extraContext);
  if (imports.length === 0) {
    return { missingModules: [], missingFiles: [] };
  }

  const baseFile = extractErrorFilePath(extraContext);
  const missingModules = new Set<string>();
  const missingFiles = new Set<string>();

  imports.forEach((importPath) => {
    if (isBareModuleImport(importPath)) {
      missingModules.add(importPath);
      return;
    }
    const resolved = resolveMissingRelativeImport(rootPath, baseFile, importPath);
    if (resolved) {
      missingFiles.add(resolved);
    }
  });

  return {
    missingModules: Array.from(missingModules),
    missingFiles: Array.from(missingFiles)
  };
}

function extractMissingImports(text: string): string[] {
  const patterns = [
    /Failed to resolve import ["']([^"']+)["']/gi,
    /Cannot find module ['"]([^'"]+)['"]/gi,
    /Can't resolve ['"]([^'"]+)['"]/gi
  ];
  const results: string[] = [];
  patterns.forEach((pattern) => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1]?.trim();
      if (value) {
        results.push(value);
      }
    }
  });
  return results;
}

function extractErrorFilePath(text: string): string | null {
  const regex = /File:\s+([^\s]+?\.(?:tsx|ts|jsx|js))/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = regex.exec(text)) !== null) {
    last = match[1];
  }
  return last;
}

function isBareModuleImport(importPath: string): boolean {
  if (importPath.startsWith('.') || importPath.startsWith('/')) {
    return false;
  }
  if (/^[a-zA-Z]:\\/.test(importPath)) {
    return false;
  }
  return true;
}

function resolveMissingRelativeImport(
  rootPath: string,
  baseFilePath: string | null,
  importPath: string
): string | null {
  if (!baseFilePath) {
    return null;
  }
  const normalizedBase = baseFilePath.replace(/\//g, path.sep);
  const baseDir = path.dirname(normalizedBase);
  const rawImport = importPath.replace(/\\/g, path.sep);
  const hasExtension = path.extname(rawImport).length > 0;
  const baseExt = path.extname(normalizedBase);
  const preferredExt = ['.tsx', '.ts', '.jsx', '.js'].includes(baseExt) ? baseExt : '.jsx';

  const baseResolved = path.resolve(baseDir, rawImport);
  const candidates = hasExtension
    ? [baseResolved]
    : [
        `${baseResolved}${preferredExt}`,
        `${baseResolved}.jsx`,
        `${baseResolved}.js`,
        `${baseResolved}.tsx`,
        `${baseResolved}.ts`
      ];

  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (existing) {
    return null;
  }

  const target = candidates[0];
  const relative = path.relative(rootPath, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return relative;
}

function getInstallCommand(rootPath: string, packageManager: string | null): string {
  if (packageManager === 'yarn') {
    return 'yarn install';
  }
  if (packageManager === 'pnpm') {
    return 'pnpm install';
  }
  if (packageManager === 'bun') {
    return 'bun install';
  }
  if (fs.existsSync(path.join(rootPath, 'pnpm-lock.yaml'))) {
    return 'pnpm install';
  }
  if (fs.existsSync(path.join(rootPath, 'yarn.lock'))) {
    return 'yarn install';
  }
  if (fs.existsSync(path.join(rootPath, 'bun.lockb'))) {
    return 'bun install';
  }
  return 'npm install';
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
  signal?: AbortSignal,
  projectSubdir?: string | null
): Promise<FileUpdate[] | null> {
  const resolved = selectedFiles
    .map((candidate) => applyProjectSubdir(candidate, projectSubdir ?? null))
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
    updates = await requestUpdatesInChunks(
      instruction,
      filePayloads,
      activeRelativePath,
      extraContext,
      output,
      panelApi,
      history,
      signal
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
  traceLabel?: string,
  maxRetries: number = MAX_JSON_RETRIES
): Promise<{ files?: unknown }> {
  let lastError: unknown;
  const labelBase = traceLabel ?? (mode === 'selection' ? 'File selection' : 'Update');
  const schema = mode === 'selection' ? FILE_SELECTION_SCHEMA : FILE_UPDATE_SCHEMA;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptMessages = buildJsonRetryMessages(messages, attempt, mode);
    try {
      const attemptLabel = attempt === 0 ? 'initial' : `retry ${attempt}/${maxRetries}`;
      recordPrompt(`${labelBase} prompt (${attemptLabel})`, attemptMessages, true);
      const payload = await requestStructuredJson<{ files?: unknown }>(
        attemptMessages,
        schema,
        { signal, maxRetries: 0 }
      );
      recordResponse(`${labelBase} response (${attemptLabel})`, JSON.stringify(payload));
      return payload;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      lastError = error;
      recordStep(`${labelBase} JSON error`, String(error));
      logVerbose(output, panelApi, `LLM error (retry ${attempt}/${maxRetries}): ${String(error)}`);
      if (attempt < maxRetries) {
        logVerbose(output, panelApi, `Retrying with stricter JSON request (${attempt + 1}/${maxRetries})...`);
      }
    }
  }
  logOutput(output, panelApi, 'Structured JSON parsing failed after retries.');
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
  signal: AbortSignal | undefined
): Promise<Array<{ path: string; content: string }>> {
  const { maxFiles, maxChars } = getUpdateChunkLimits();
  const chunks = chunkFilePayloads(filePayloads, maxFiles, maxChars);
  if (chunks.length > 1) {
    logVerbose(output, panelApi, `Chunking update into ${chunks.length} batches.`);
    recordStep('Update chunking', `Split into ${chunks.length} batches (max ${maxFiles} files / ${maxChars} chars).`);
  } else {
    recordStep('Update chunking', `Single batch (max ${maxFiles} files / ${maxChars} chars).`);
  }

  const updates: Array<{ path: string; content: string }> = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const label = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : '';
    const chunkFiles = chunk.map((file) => file.path).join('\n');
    recordStep(`Update chunk ${index + 1}/${chunks.length}`, chunkFiles || '(no files)');
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
      'update',
      `Update chunk ${index + 1}/${chunks.length}`
    );
    recordPayload(`Update JSON ${index + 1}/${chunks.length}`, JSON.stringify(payload, null, 2));
    const chunkUpdates = Array.isArray(payload.files) ? payload.files : [];
    logVerbose(output, panelApi, `LLM returned updates for ${chunkUpdates.length} files${label}.`);
    updates.push(...chunkUpdates);
  }

  return updates;
}

/** Compute chunking limits for multi-file update requests. */
function getUpdateChunkLimits(): { maxFiles: number; maxChars: number } {
  const configuredMaxFiles = getForgeSetting<number>('maxFilesPerUpdate');
  const configuredMaxChars = getForgeSetting<number>('maxUpdateChars');
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
