// Node utilities for filesystem access and paths.
import * as fs from 'fs';
import * as path from 'path';
// VS Code extension API.
import * as vscode from 'vscode';
// Context harvester for Phase 1.
import { harvestContext, type ProjectContext } from './context';
import { buildValidationOptions, runCommand, type ValidationOption } from './validation';
import { commitAll, getCurrentBranch, getDiffStat, getGitStatus, getRemotes, isGitRepo, push } from './git';
import type { ChatCompletionResponse, ChatMessage } from './llm/client';
import { callChatCompletion, pingLLM } from './llm/client';
import type { ForgeUiApi } from './ui/api';
import { ForgePanel } from './ui/panel';
import { ForgeViewProvider } from './ui/view';
import { getWorkspaceIndex, startWorkspaceIndexing } from './indexer/workspaceIndex';

let lastActiveFile: string | null = null;
let activeAbortController: AbortController | null = null;
let panelInstance: ForgePanel | null = null;
let viewProviderInstance: ForgeViewProvider | null = null;
let lastManualSelection: string[] = [];
let runTimer: NodeJS.Timeout | null = null;
let keepAliveTimer: NodeJS.Timeout | null = null;

export function activate(context: vscode.ExtensionContext): void {
  // Output channel visible in View -> Output.
  const output = vscode.window.createOutputChannel('Forge');
  let panelApi: ForgeUiApi | undefined;

  // Sync VS Code settings into env vars for shared LLM configuration.
  applyLLMSettingsToEnv();
  const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('forge')) {
      applyLLMSettingsToEnv();
      startKeepAlive();
    }
  });

  startWorkspaceIndexing(context);
  startKeepAlive();

  // Register the Forge run command (input box).
  const runCommand = vscode.commands.registerCommand('forge.run', async () => {
    const instruction = await vscode.window.showInputBox({
      prompt: 'What should Forge do in the active file?',
      placeHolder: 'e.g., Add a create order button'
    });

    if (!instruction) {
      void vscode.window.showInformationMessage('Forge: No instruction provided.');
      return;
    }

    await runForge(instruction, output);
  });

  // Register the Forge UI command (webview panel).
  const uiCommand = vscode.commands.registerCommand('forge.ui', () => {
    const panel = ForgePanel.createOrShow();
    panelInstance = panel;
    const api = panel.getApi();
    panelApi = api;
    api.setStatus('Idle');
    panel.setHandler((instruction) => {
      void runForge(instruction, output, api);
    });
    panel.setStopHandler(() => {
      cancelActiveRun(api, output);
    });
    updateActiveFile(api);
  });

  const viewProvider = new ForgeViewProvider(context.extensionUri);
  viewProviderInstance = viewProvider;
  const viewRegistration = vscode.window.registerWebviewViewProvider(
    ForgeViewProvider.viewType,
    viewProvider
  );
  viewProvider.setHandler((instruction) => {
    void runForge(instruction, output, viewProvider.getApi());
  });
  viewProvider.setStopHandler(() => {
    cancelActiveRun(viewProvider.getApi(), output);
  });
  viewProvider.setReadyHandler(() => {
    updateActiveFile(viewProvider.getApi());
  });

  // Register the Forge context command (Phase 1 harvesting).
  const contextCommand = vscode.commands.registerCommand('forge.context', () => {
    const contextObject = harvestContext();
    logContext(output, contextObject);
    void vscode.window.showInformationMessage('Forge context captured.');
  });

  const activeEditorWatcher = vscode.window.onDidChangeActiveTextEditor(() => {
    updateActiveFile(panelApi);
    updateActiveFile(viewProvider.getApi());
  });

  // Dispose commands when the extension deactivates.
  context.subscriptions.push(
    runCommand,
    uiCommand,
    viewRegistration,
    contextCommand,
    configWatcher,
    activeEditorWatcher
  );
}

export function deactivate(): void {}
function updateActiveFile(panelApi?: ForgeUiApi): void {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) {
    if (lastActiveFile) {
      panelApi?.setActiveFile(lastActiveFile);
    } else {
      panelApi?.setActiveFile('None');
    }
    return;
  }

  const activeFilePath = activeEditor.document.uri.fsPath;
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const relativePath = rootPath ? path.relative(rootPath, activeFilePath) : path.basename(activeFilePath);
  lastActiveFile = relativePath;
  panelApi?.setActiveFile(relativePath);
}

async function runForge(
  instruction: string,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi
): Promise<void> {
  activeAbortController?.abort();
  activeAbortController = new AbortController();
  const signal = activeAbortController.signal;
  const startedAt = Date.now();
  if (runTimer) {
    clearInterval(runTimer);
  }
  if (panelApi) {
    runTimer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      panelApi.setStatus(`Running ${formatDuration(elapsedMs)}`);
    }, 1000);
  }
  try {
  output.clear();
  output.show(true);

  const setStatus = (text: string) => {
    panelApi?.setStatus(text);
  };

  const log = (text: string) => {
    output.appendLine(text);
    panelApi?.appendLog(text);
  };

  setStatus('Checking active editor...');

  const config = vscode.workspace.getConfiguration('forge');
  const enableMultiFile = config.get<boolean>('enableMultiFile') === true;
  const intent = classifyIntent(instruction);

  const activeEditor = vscode.window.activeTextEditor;
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  let activeFilePath: string | null = activeEditor?.document.uri.fsPath ?? null;
  let relativePath: string | null = null;

  if (activeFilePath) {
    relativePath = rootPath ? path.relative(rootPath, activeFilePath) : path.basename(activeFilePath);
  } else if (lastActiveFile && rootPath) {
    activeFilePath = path.join(rootPath, lastActiveFile);
    relativePath = lastActiveFile;
  }

  if (!rootPath) {
    log('No workspace folder open.');
    void vscode.window.showErrorMessage('Forge: Open a workspace folder first.');
    setStatus('Idle');
    return;
  }

  if (intent === 'question') {
    await answerQuestion(instruction, rootPath, output, panelApi, signal);
    setStatus('Done');
    return;
  }

  if (intent === 'fix') {
    await runValidationFirstFix(rootPath, instruction, output, panelApi, signal);
    setStatus('Done');
    return;
  }

  if (!enableMultiFile && (!activeFilePath || !relativePath)) {
    log('No active editor. Open a file to edit first.');
    void vscode.window.showErrorMessage('Forge: Open a file to edit first.');
    setStatus('Idle');
    return;
  }

  const skipConfirmations = config.get<boolean>('skipConfirmations') === true;
  const skipTargetConfirmation = config.get<boolean>('skipTargetConfirmation') === true;

  if (!enableMultiFile && !(skipConfirmations || skipTargetConfirmation)) {
    const confirmTarget = await vscode.window.showWarningMessage(
      `Forge will edit: ${relativePath}. Continue?`,
      'Continue',
      'Cancel'
    );

    if (confirmTarget !== 'Continue') {
      void vscode.window.showInformationMessage('Forge: Cancelled.');
      setStatus('Cancelled');
      return;
    }
  }

  if (enableMultiFile) {
    const updatedFiles = await requestMultiFileUpdate(
      rootPath,
      instruction,
      relativePath,
      output,
      panelApi,
      panelInstance,
      viewProviderInstance,
      undefined,
      signal
    );

    if (!updatedFiles || updatedFiles.length === 0) {
      void vscode.window.showInformationMessage('Forge: No changes produced.');
      setStatus('No changes');
      return;
    }

    await logActionPurpose(
      instruction,
      updatedFiles.map((file) => file.relativePath),
      output,
      panelApi,
      signal
    );

    const summaries: string[] = [];
    for (const file of updatedFiles) {
      const summary = getLineChangeSummary(file.original, file.updated, file.relativePath);
      if (summary) {
        summaries.push(summary);
      }
      const inlineDiff = buildInlineDiffPreview(file.original, file.updated, file.relativePath);
      if (inlineDiff && panelApi) {
        panelApi.appendDiff(inlineDiff);
      }
    }
    summaries.forEach((line) => log(line));

    if (!skipConfirmations) {
      const confirmApply = await vscode.window.showWarningMessage(
        `Apply changes to ${updatedFiles.length} files?`,
        'Apply',
        'Cancel'
      );

      if (confirmApply !== 'Apply') {
        void vscode.window.showInformationMessage('Forge: Changes not applied.');
        setStatus('Cancelled');
        return;
      }
    }

    const writeOk = applyFileUpdates(updatedFiles, output, panelApi);
    if (!writeOk) {
      setStatus('Error');
      return;
    }
  } else {
    if (!activeFilePath || !relativePath) {
      log('No active editor. Open a file to edit first.');
      void vscode.window.showErrorMessage('Forge: Open a file to edit first.');
      setStatus('Idle');
      return;
    }
    const updatedFile = await requestSingleFileUpdate(
      activeFilePath,
      relativePath,
      instruction,
      output,
      panelApi,
      signal
    );

    if (!updatedFile) {
      void vscode.window.showInformationMessage('Forge: No changes produced.');
      setStatus('No changes');
      return;
    }

    await logActionPurpose(instruction, [updatedFile.relativePath], output, panelApi, signal);

    const summary = getLineChangeSummary(
      updatedFile.original,
      updatedFile.updated,
      updatedFile.relativePath
    );
    if (summary) {
      log(summary);
    }
    const inlineDiff = buildInlineDiffPreview(
      updatedFile.original,
      updatedFile.updated,
      updatedFile.relativePath
    );
    if (inlineDiff && panelApi) {
      panelApi.appendDiff(inlineDiff);
    }

    const showDiffPreview = config.get<boolean>('showDiffPreview') !== false;
    if (showDiffPreview) {
      setStatus('Reviewing diff...');
      try {
        const originalUri = vscode.Uri.file(updatedFile.fullPath);
        const updatedDoc = await vscode.workspace.openTextDocument({ content: updatedFile.updated });
        await vscode.commands.executeCommand(
          'vscode.diff',
          originalUri,
          updatedDoc.uri,
          `Forge: Proposed Changes (${updatedFile.relativePath})`
        );
      } catch (error) {
        log(`Diff view error: ${String(error)}`);
      }
    }

    if (!skipConfirmations) {
      const confirmApply = await vscode.window.showWarningMessage(
        'Apply the proposed changes to the file?',
        'Apply',
        'Cancel'
      );

      if (confirmApply !== 'Apply') {
        void vscode.window.showInformationMessage('Forge: Changes not applied.');
        setStatus('Cancelled');
        return;
      }
    }

    try {
      fs.writeFileSync(updatedFile.fullPath, updatedFile.updated, 'utf8');
      void vscode.window.showInformationMessage('Forge: Changes applied.');
    } catch (error) {
      log(`Write error: ${String(error)}`);
      void vscode.window.showErrorMessage('Forge: Failed to write the file.');
      setStatus('Error');
      return;
    }
  }

  if (rootPath) {
    const config = vscode.workspace.getConfiguration('forge');
    const autoFixValidation = config.get<boolean>('autoFixValidation') === true;
    const maxFixRetries = Math.max(0, config.get<number>('autoFixMaxRetries') ?? 0);

    setStatus('Running validation...');
    let validationResult = await maybeRunValidation(rootPath, output);

    if (!validationResult.ok && autoFixValidation && maxFixRetries > 0) {
      for (let attempt = 1; attempt <= maxFixRetries; attempt += 1) {
        log(`Auto-fix attempt ${attempt} of ${maxFixRetries}...`);
        setStatus(`Auto-fix ${attempt}/${maxFixRetries}`);
        const fixed = await attemptAutoFix(
          rootPath,
          instruction,
          validationResult.output,
          output,
          panelApi,
          signal
        );
        if (!fixed) {
          break;
        }

        setStatus('Re-running validation...');
        validationResult = await maybeRunValidation(rootPath, output);
        if (validationResult.ok) {
          log('Validation passed after auto-fix.');
          setStatus('Validation passed');
          break;
        }
      }
    }

    if (!validationResult.ok) {
      void vscode.window.showErrorMessage('Forge: Validation failed.');
      setStatus('Validation failed');
      return;
    }

    log('Validation passed.');

    const enableGitWorkflow = config.get<boolean>('enableGitWorkflow') === true;
    if (enableGitWorkflow) {
      setStatus('Git workflow...');
      await maybeRunGitWorkflow(rootPath, output);
    }
  }

  } finally {
    const elapsedMs = Date.now() - startedAt;
    if (runTimer) {
      clearInterval(runTimer);
      runTimer = null;
    }
    if (panelApi) {
      panelApi.setStatus('Done');
    }
    if (!signal.aborted) {
      const doneMessage = `Done in ${formatDuration(elapsedMs)}.`;
      output.appendLine(doneMessage);
      panelApi?.appendLog(doneMessage);
    }
    activeAbortController = null;
  }
}

function logContext(output: vscode.OutputChannel, contextObject: ProjectContext): void {
  output.clear();
  output.appendLine(JSON.stringify(contextObject, null, 2));
  output.show(true);
}

function applyLLMSettingsToEnv(): void {
  const config = vscode.workspace.getConfiguration('forge');
  const endpoint = config.get<string>('llmEndpoint');
  const model = config.get<string>('llmModel');
  const apiKey = config.get<string>('llmApiKey');
  const timeoutMs = config.get<number>('llmTimeoutMs');

  if (endpoint && endpoint.trim().length > 0) {
    process.env.FORGE_LLM_ENDPOINT = endpoint.trim();
  }
  if (model && model.trim().length > 0) {
    process.env.FORGE_LLM_MODEL = model.trim();
  }
  if (apiKey && apiKey.trim().length > 0) {
    process.env.FORGE_LLM_API_KEY = apiKey.trim();
  }
  if (timeoutMs && Number.isFinite(timeoutMs)) {
    process.env.FORGE_LLM_TIMEOUT_MS = String(timeoutMs);
  }
}

function startKeepAlive(): void {
  const config = vscode.workspace.getConfiguration('forge');
  const intervalSeconds = config.get<number>('keepAliveSeconds') ?? 0;
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (!intervalSeconds || intervalSeconds <= 0) {
    return;
  }
  keepAliveTimer = setInterval(() => {
    void pingLLM().catch(() => undefined);
  }, intervalSeconds * 1000);
}

type ValidationResult = {
  ok: boolean;
  output: string;
  command: string | null;
  label: string | null;
};

async function maybeRunValidation(rootPath: string, output: vscode.OutputChannel): Promise<ValidationResult> {
  const config = vscode.workspace.getConfiguration('forge');
  const autoValidation = config.get<boolean>('autoValidation') !== false;
  const contextObject = harvestContext();
  const options = buildValidationOptions(contextObject.packageJson, contextObject.packageManager);

  if (options.length === 0) {
    return { ok: true, output: '', command: null, label: null };
  }

  let selected: ValidationOption | null = null;
  if (autoValidation) {
    selected = pickBestValidationOption(options);
  } else {
    const items = options.map((option) => ({
      label: option.label,
      description: option.command
    }));

    items.push({ label: 'Skip validation', description: '' });

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a validation command to run'
    });

    if (!pick || pick.label === 'Skip validation') {
      return { ok: true, output: '', command: null, label: null };
    }

    selected = options.find((option) => option.label === pick.label) ?? null;
  }

  if (!selected) {
    return { ok: true, output: '', command: null, label: null };
  }

  output.appendLine(`Running validation: ${selected.label}`);
  try {
    const result = await runCommand(selected.command, rootPath, output);
    return {
      ok: result.code === 0,
      output: result.output,
      command: selected.command,
      label: selected.label
    };
  } catch (error) {
    output.appendLine(`Validation error: ${String(error)}`);
    return { ok: false, output: String(error), command: selected.command, label: selected.label };
  }
}

function pickBestValidationOption(options: ValidationOption[]): ValidationOption | null {
  const priority = ['test', 'typecheck', 'lint', 'build'];
  for (const label of priority) {
    const found = options.find((option) => option.label === label);
    if (found) {
      return found;
    }
  }
  return options[0] ?? null;
}

async function maybeRunGitWorkflow(rootPath: string, output: vscode.OutputChannel): Promise<void> {
  const config = vscode.workspace.getConfiguration('forge');
  const skipConfirmations = config.get<boolean>('skipConfirmations') === true;

  if (!skipConfirmations) {
    const proceed = await vscode.window.showWarningMessage(
      'Start Git workflow (status, commit, optional push)?',
      'Continue',
      'Skip'
    );

    if (proceed !== 'Continue') {
      return;
    }
  }

  if (!(await isGitRepo(rootPath))) {
    void vscode.window.showInformationMessage('Forge: Not a Git repository.');
    return;
  }

  const statusLines = await getGitStatus(rootPath);
  if (statusLines.length === 0) {
    void vscode.window.showInformationMessage('Forge: No changes to commit.');
    return;
  }

  output.appendLine('Git status:');
  statusLines.forEach((line) => output.appendLine(line));

  const diffStat = await getDiffStat(rootPath);
  if (diffStat.trim().length > 0) {
    output.appendLine('Diff summary:');
    output.appendLine(diffStat.trim());
  }

  const message = await vscode.window.showInputBox({
    prompt: 'Commit message',
    placeHolder: 'feat: describe your change'
  });

  if (!message) {
    void vscode.window.showInformationMessage('Forge: Commit cancelled.');
    return;
  }

  if (!skipConfirmations) {
    const confirmCommit = await vscode.window.showWarningMessage(
      `Commit with message: "${message}"?`,
      'Commit',
      'Cancel'
    );

    if (confirmCommit !== 'Commit') {
      void vscode.window.showInformationMessage('Forge: Commit cancelled.');
      return;
    }
  }

  try {
    await commitAll(rootPath, message, output);
    void vscode.window.showInformationMessage('Forge: Commit created.');
  } catch (error) {
    output.appendLine(`Git commit error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: Commit failed.');
    return;
  }

  const remotes = await getRemotes(rootPath);
  if (remotes.length === 0) {
    return;
  }

  const branch = await getCurrentBranch(rootPath);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];

  if (!skipConfirmations) {
    const confirmPush = await vscode.window.showWarningMessage(
      `Push to ${remote}/${branch}?`,
      'Push',
      'Skip'
    );

    if (confirmPush !== 'Push') {
      return;
    }
  }

  try {
    await push(rootPath, remote, branch, output);
    void vscode.window.showInformationMessage('Forge: Push completed.');
  } catch (error) {
    output.appendLine(`Git push error: ${String(error)}`);
    void vscode.window.showErrorMessage('Forge: Push failed.');
  }
}

function extractUpdatedFile(response: ChatCompletionResponse): string {
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

function isLikelyDiff(text: string): boolean {
  return text.includes('--- ') && text.includes('+++ ') && text.includes('@@');
}

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

function shouldAllowComments(instruction: string): boolean {
  return /\b(comment|comments|document|documentation|explain|explanation)\b/i.test(instruction);
}

type FileUpdate = {
  fullPath: string;
  relativePath: string;
  original: string;
  updated: string;
};

type FileSelectionRequester = {
  requestFileSelection: (files: string[], preselected: string[]) => Promise<string[]>;
};

async function requestSingleFileUpdate(
  fullPath: string,
  relativePath: string,
  instruction: string,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
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
  const messages = buildFullFileMessages(instruction, relativePath, originalContent);

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

async function requestMultiFileUpdate(
  rootPath: string,
  instruction: string,
  activeRelativePath: string | null,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  panel?: ForgePanel | null,
  viewProvider?: ForgeViewProvider | null,
  extraContext?: string,
  signal?: AbortSignal
): Promise<FileUpdate[] | null> {
  const contextObject = harvestContext();
  const filesList = contextObject.files && contextObject.files.length > 0
    ? contextObject.files
    : listWorkspaceFiles(rootPath, 6, 2000);
  if (filesList.length === 0) {
    logOutput(output, panelApi, 'No files found in workspace.');
    return null;
  }

  const suggestedFiles = suggestFilesForInstruction(
    instruction,
    filesList,
    getWorkspaceIndex()
  );
  const preselected = lastManualSelection.length > 0 ? lastManualSelection : suggestedFiles;
  const userSelection = await requestUserFileSelection(filesList, preselected, panel, viewProvider);
  if (userSelection) {
    if (userSelection.length === 0) {
      logOutput(
        output,
        panelApi,
        'No files selected. Please specify which files to edit or provide more context.'
      );
      return null;
    }

    lastManualSelection = userSelection;
    return buildUpdatesFromUserSelection(
      userSelection,
      rootPath,
      instruction,
      activeRelativePath,
      output,
      panelApi,
      extraContext,
      signal
    );
  }

  logVerbose(output, panelApi, 'Requesting file selection from the local LLM...');
  panelApi?.setStatus('Selecting files...');
  const selectionMessages = buildFileSelectionMessages(
    instruction,
    filesList,
    activeRelativePath,
    extraContext,
    getWorkspaceIndex()
  );

  let selectedFiles: string[];
  try {
    const response = await callChatCompletion({}, selectionMessages, signal);
    const payload = extractJsonPayload(response);
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

  const mentionedFiles = extractMentionedFiles(instruction, filesList);
  const uniquePaths = Array.from(
    new Set([...selectedFiles.map((item) => String(item)), ...mentionedFiles])
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
  panelApi?.setStatus('Requesting LLM...');
  const updateMessages = buildMultiFileUpdateMessages(
    instruction,
    filePayloads,
    activeRelativePath,
    extraContext
  );

  let updates: Array<{ path: string; content: string }>;
  try {
    const response = await callChatCompletion({}, updateMessages, signal);
    const payload = extractJsonPayload(response);
    updates = Array.isArray(payload.files) ? payload.files : [];
    logVerbose(output, panelApi, `LLM returned updates for ${updates.length} files.`);
  } catch (error) {
    if (isAbortError(error)) {
      logOutput(output, panelApi, 'LLM request aborted.');
      return null;
    }
    logOutput(output, panelApi, `LLM error: ${String(error)}`);
    logVerbose(output, panelApi, 'Retrying update with stricter JSON request...');
    try {
      const retryMessages = buildStrictJsonRetryMessages(updateMessages);
      const retryResponse = await callChatCompletion({}, retryMessages, signal);
      const retryPayload = extractJsonPayload(retryResponse);
      updates = Array.isArray(retryPayload.files) ? retryPayload.files : [];
      logVerbose(output, panelApi, `LLM returned updates for ${updates.length} files (retry).`);
    } catch (retryError) {
      if (isAbortError(retryError)) {
        logOutput(output, panelApi, 'LLM request aborted.');
        return null;
      }
      logOutput(output, panelApi, `LLM error: ${String(retryError)}`);
      void vscode.window.showErrorMessage('Forge: LLM update failed.');
      return null;
    }
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

function applyFileUpdates(
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

async function attemptAutoFix(
  rootPath: string,
  instruction: string,
  validationOutput: string,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
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

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function buildFileSelectionMessages(
  instruction: string,
  filesList: string[],
  activeRelativePath: string | null,
  extraContext?: string,
  index?: { generatedAt: string; symbols: Array<{ name: string; kind: string; containerName: string | null; relativePath: string }>; files: string[] } | null
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

  return [
    {
      role: 'system',
      content:
        'You are a coding assistant. Select the files that must be edited. ' +
        'Return ONLY valid JSON in the format {"files":["path1","path2"]}. ' +
        'Paths must be relative to the project root.'
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

function buildQuestionMessages(
  instruction: string,
  context: ProjectContext,
  filesList: string[]
): ChatMessage[] {
  const preview = filesList.slice(0, 300).join('\n');
  const truncated = filesList.length > 300 ? '\n...(truncated)' : '';

  return [
    {
      role: 'system',
      content:
        'You are a helpful assistant. Answer the question using the provided project context. ' +
        'If the context is insufficient, ask the user for the missing details. ' +
        'Do not claim you lack access; instead request the needed file or data.'
    },
    {
      role: 'user',
      content:
        `Question: ${instruction}\n\n` +
        'Project context:\n' +
        `${JSON.stringify(
          {
            workspaceRoot: context.workspaceRoot,
            activeEditorFile: context.activeEditorFile,
            packageManager: context.packageManager,
            frontendFramework: context.frontendFramework,
            backendFramework: context.backendFramework
          },
          null,
          2
        )}\n\n` +
        'Files (partial list):\n' +
        preview +
        truncated
    }
  ];
}

function buildMultiFileUpdateMessages(
  instruction: string,
  files: Array<{ path: string; content: string }>,
  activeRelativePath: string | null,
  extraContext?: string
): ChatMessage[] {
  const activeNote = activeRelativePath ? `Active file: ${activeRelativePath}\n` : '';
  const contextNote = extraContext ? `\nValidation output:\n${extraContext}\n` : '';
  const fileBlocks = files
    .map((file) => `File: ${file.path}\n---\n${file.content}\n---`)
    .join('\n\n');

  return [
    {
      role: 'system',
      content:
        'You are a coding assistant. Return ONLY valid JSON in the format ' +
        '{"files":[{"path":"relative/path","content":"full file content"}]}. ' +
        'Provide the full updated content for each file.'
    },
    {
      role: 'user',
      content:
        `Instruction: ${instruction}\n` +
        activeNote +
        contextNote +
        'Current file contents:\n' +
        fileBlocks +
        '\nReturn JSON only.'
    }
  ];
}

function extractJsonPayload(response: ChatCompletionResponse): { files?: unknown } {
  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) {
    const errorMessage = response.error?.message ?? 'No content returned by LLM.';
    throw new Error(errorMessage);
  }

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : content;

  try {
    return JSON.parse(raw) as { files?: unknown };
  } catch (error) {
    throw new Error(`Invalid JSON from LLM: ${String(error)}`);
  }
}

async function requestUserFileSelection(
  filesList: string[],
  preselected: string[],
  panel?: ForgePanel | null,
  viewProvider?: ForgeViewProvider | null
): Promise<string[] | null> {
  if (panel) {
    return panel.requestFileSelection(filesList, preselected);
  }
  if (viewProvider) {
    return viewProvider.requestFileSelection(filesList, preselected);
  }
  return null;
}

async function buildUpdatesFromUserSelection(
  selectedFiles: string[],
  rootPath: string,
  instruction: string,
  activeRelativePath: string | null,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  extraContext?: string,
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
  panelApi?.setStatus('Requesting LLM...');
  const updateMessages = buildMultiFileUpdateMessages(
    instruction,
    filePayloads,
    activeRelativePath,
    extraContext
  );

  let updates: Array<{ path: string; content: string }>;
  try {
    const response = await callChatCompletion({}, updateMessages, signal);
    const payload = extractJsonPayload(response);
    updates = Array.isArray(payload.files) ? payload.files : [];
    logOutput(output, panelApi, `LLM returned updates for ${updates.length} files.`);
  } catch (error) {
    if (isAbortError(error)) {
      logOutput(output, panelApi, 'LLM request aborted.');
      return null;
    }
    logOutput(output, panelApi, `LLM error: ${String(error)}`);
    logOutput(output, panelApi, 'Retrying update with stricter JSON request...');
    try {
      const retryMessages = buildStrictJsonRetryMessages(updateMessages);
      const retryResponse = await callChatCompletion({}, retryMessages, signal);
      const retryPayload = extractJsonPayload(retryResponse);
      updates = Array.isArray(retryPayload.files) ? retryPayload.files : [];
      logOutput(output, panelApi, `LLM returned updates for ${updates.length} files (retry).`);
    } catch (retryError) {
      if (isAbortError(retryError)) {
        logOutput(output, panelApi, 'LLM request aborted.');
        return null;
      }
      logOutput(output, panelApi, `LLM error: ${String(retryError)}`);
      void vscode.window.showErrorMessage('Forge: LLM update failed.');
      return null;
    }
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

function buildStrictJsonRetryMessages(messages: ChatMessage[]): ChatMessage[] {
  const strictSystem: ChatMessage = {
    role: 'system',
    content:
      'Return ONLY valid JSON. Do not include code fences, trailing commas, or unescaped newlines. ' +
      'Ensure all strings are properly JSON-escaped.'
  };
  return [strictSystem, ...messages];
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds - minutes * 60);
  return `${minutes}m ${remaining}s`;
}

function cancelActiveRun(panelApi: ForgeUiApi, output: vscode.OutputChannel): void {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
    panelApi.setStatus('Stopped');
    logOutput(output, panelApi, 'Run stopped.');
  }
}

async function logActionPurpose(
  instruction: string,
  files: string[],
  output: vscode.OutputChannel,
  panelApi: ForgeUiApi | undefined,
  signal?: AbortSignal
): Promise<void> {
  const messages = buildActionPurposeMessages(instruction, files);
  logOutput(output, panelApi, 'Summarizing actions...');
  try {
    const response = await callChatCompletion({}, messages, signal);
    const content = response.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return;
    }
    content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .forEach((line) => logOutput(output, panelApi, line));
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
  }
}

function buildActionPurposeMessages(instruction: string, files: string[]): ChatMessage[] {
  const fileList = files.slice(0, 20).join(', ');
  return [
    {
      role: 'system',
      content:
        'Summarize the intended changes as short bullet points. ' +
        'Each bullet must be "Action - Purpose" and must be specific. ' +
        'Do not mention that you are an AI. Return 1-3 bullets only.'
    },
    {
      role: 'user',
      content:
        `Instruction: ${instruction}\n` +
        `Target files: ${fileList}\n` +
        'Return bullets only.'
    }
  ];
}

async function runValidationFirstFix(
  rootPath: string,
  instruction: string,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  signal?: AbortSignal
): Promise<void> {
  logOutput(output, panelApi, 'Running validation (fix mode)...');
  let validationResult = await maybeRunValidation(rootPath, output);
  if (validationResult.ok) {
    logOutput(output, panelApi, 'Validation already passing.');
    return;
  }

  const config = vscode.workspace.getConfiguration('forge');
  const autoFixValidation = config.get<boolean>('autoFixValidation') === true;
  const maxFixRetries = Math.max(0, config.get<number>('autoFixMaxRetries') ?? 0);

  if (!autoFixValidation || maxFixRetries === 0) {
    logOutput(output, panelApi, 'Auto-fix disabled.');
    return;
  }

  for (let attempt = 1; attempt <= maxFixRetries; attempt += 1) {
    logOutput(output, panelApi, `Auto-fix attempt ${attempt} of ${maxFixRetries}...`);
    const fixed = await attemptAutoFix(
      rootPath,
      instruction,
      validationResult.output,
      output,
      panelApi,
      signal
    );
    if (!fixed) {
      break;
    }

    logOutput(output, panelApi, 'Re-running validation...');
    validationResult = await maybeRunValidation(rootPath, output);
    if (validationResult.ok) {
      logOutput(output, panelApi, 'Validation passed after auto-fix.');
      return;
    }
  }

  logOutput(output, panelApi, 'Validation still failing after auto-fix attempts.');
}

function extractMentionedFiles(instruction: string, filesList: string[]): string[] {
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

async function findFilesByKeywords(
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

function extractKeywords(instruction: string): string[] {
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

function logOutput(output: vscode.OutputChannel, panelApi: ForgeUiApi | undefined, text: string): void {
  output.appendLine(text);
  panelApi?.appendLog(text);
}

function logVerbose(output: vscode.OutputChannel, panelApi: ForgeUiApi | undefined, text: string): void {
  const config = vscode.workspace.getConfiguration('forge');
  if (config.get<boolean>('verboseLogs') === true) {
    logOutput(output, panelApi, text);
  }
}

function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const message = String(error);
  return message.toLowerCase().includes('aborted');
}

function findFileByBasename(instruction: string, filesList: string[]): string | null {
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

type Intent = 'edit' | 'question' | 'fix';

function classifyIntent(instruction: string): Intent {
  const trimmed = instruction.trim();
  const lowered = trimmed.toLowerCase();
  if (/(resolve|fix|repair).*(error|errors|failing|failure|tests|test|build|lint|typecheck)/.test(lowered)) {
    return 'fix';
  }
  if (/(add|update|change|fix|refactor|remove|delete|create|implement|comment|comments|document)\b/.test(lowered)) {
    return 'edit';
  }
  if (trimmed.endsWith('?')) {
    return 'question';
  }
  if (/(^|\s)(how|what|why|where|when|which|who)\b/.test(lowered)) {
    return 'question';
  }
  if (/^(show|list|count)\b/.test(lowered)) {
    return 'question';
  }
  if (/^(check|inspect|review|summarize|summary|describe)\b/.test(lowered)) {
    return 'question';
  }
  if (lowered.includes('in points') || lowered.includes('point form')) {
    return 'question';
  }
  return 'edit';
}

async function answerQuestion(
  instruction: string,
  rootPath: string,
  output: vscode.OutputChannel,
  panelApi?: ForgeUiApi,
  signal?: AbortSignal
): Promise<void> {
  const lowered = instruction.toLowerCase();
  const context = harvestContext();
  const filesList = context.files && context.files.length > 0
    ? context.files
    : listWorkspaceFiles(rootPath, 6, 5000);

  if (lowered.includes('how many files')) {
    const message = `This project has ${filesList.length} files (depth-limited scan).`;
    logOutput(output, panelApi, message);
    return;
  }

  if (/(what|which).*(files|file list)/.test(lowered) || lowered.includes('all the files')) {
    const bulletList = filesList.slice(0, 200).map((file) => `- ${file}`).join('\n');
    const truncated = filesList.length > 200 ? `\n... (${filesList.length - 200} more)` : '';
    logOutput(output, panelApi, `Files (partial list):\n${bulletList}${truncated}`);
    return;
  }

  let mentioned = extractMentionedFiles(instruction, filesList);
  if (mentioned.length === 0) {
    const deepList = listWorkspaceFiles(rootPath, 6, 5000);
    mentioned = extractMentionedFiles(instruction, deepList);
    if (mentioned.length === 0) {
      const byBasename = findFileByBasename(instruction, deepList);
      if (byBasename) {
        mentioned = [byBasename];
      }
    }
  }
  if (mentioned.length > 0) {
    const target = mentioned[0];
    const fullPath = path.join(rootPath, target);
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch (error) {
      logOutput(output, panelApi, `Unable to read ${target}: ${String(error)}`);
      return;
    }
    const maxChars = 2000;
    const snippet = content.length > maxChars ? `${content.slice(0, maxChars)}\n... (truncated)` : content;
    logOutput(output, panelApi, `Content of ${target}:\n${snippet}`);
    return;
  }

  const messages = buildQuestionMessages(instruction, context, filesList);
  logOutput(output, panelApi, 'Requesting answer from the local LLM...');
  try {
    const response = await callChatCompletion({}, messages, signal);
    const answer = response.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      logOutput(output, panelApi, 'No answer returned.');
      return;
    }
    logOutput(output, panelApi, answer);
  } catch (error) {
    if (isAbortError(error)) {
      logOutput(output, panelApi, 'LLM request aborted.');
      return;
    }
    logOutput(output, panelApi, `LLM error: ${String(error)}`);
  }
}

function listWorkspaceFiles(rootPath: string, maxDepth: number, maxFiles: number): string[] {
  const results: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];

  while (stack.length > 0 && results.length < maxFiles) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) {
          stack.push({ dir: fullPath, depth: current.depth + 1 });
        }
      } else {
        results.push(path.relative(rootPath, fullPath));
        if (results.length >= maxFiles) {
          break;
        }
      }
    }
  }

  return results;
}

function getLineChangeSummary(
  originalContent: string,
  updatedContent: string,
  relativePath: string
): string | null {
  const originalLines = originalContent.split(/\r?\n/);
  const updatedLines = updatedContent.split(/\r?\n/);
  const lcsTable = buildLcsTable(originalLines, updatedLines);
  const lcs = lcsTable[originalLines.length][updatedLines.length];
  const removed = originalLines.length - lcs;
  const added = updatedLines.length - lcs;
  const changed = added + removed;

  if (changed === 0) {
    return null;
  }

  return `Changed ${changed} lines (+${added} / -${removed}) in ${relativePath}.`;
}

function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  const table = buildLcsTable(a, b);
  return table[a.length][b.length];
}

function buildInlineDiffPreview(
  originalContent: string,
  updatedContent: string,
  relativePath: string
): string[] | null {
  const originalLines = originalContent.split(/\r?\n/);
  const updatedLines = updatedContent.split(/\r?\n/);
  const diff = buildLineDiff(originalLines, updatedLines);
  const preview = buildDiffPreviewWithContext(diff, 3);

  if (preview.length === 0) {
    return null;
  }

  const maxLines = 240;
  const sliced = preview.slice(0, maxLines);
  if (preview.length > maxLines) {
    sliced.push(`... (${preview.length - maxLines} more lines)`);
  }

  return [`Diff preview (${relativePath}):`, ...sliced];
}

function buildLineDiff(originalLines: string[], updatedLines: string[]): string[] {
  const dp = buildLcsTable(originalLines, updatedLines);
  const result: string[] = [];
  let i = originalLines.length;
  let j = updatedLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && originalLines[i - 1] === updatedLines[j - 1]) {
      result.push(` ${originalLines[i - 1]}`);
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push(`+${updatedLines[j - 1]}`);
      j -= 1;
    } else if (i > 0) {
      result.push(`-${originalLines[i - 1]}`);
      i -= 1;
    }
  }

  return result.reverse();
}

function buildLcsTable(a: string[], b: string[]): number[][] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

function buildDiffPreviewWithContext(diff: string[], contextLines: number): string[] {
  const changedIndexes: number[] = [];
  for (let i = 0; i < diff.length; i += 1) {
    if (diff[i].startsWith('+') || diff[i].startsWith('-')) {
      changedIndexes.push(i);
    }
  }

  if (changedIndexes.length === 0) {
    return [];
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changedIndexes) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(diff.length - 1, idx + contextLines);
    if (ranges.length === 0 || start > ranges[ranges.length - 1].end + 1) {
      ranges.push({ start, end });
    } else {
      ranges[ranges.length - 1].end = Math.max(ranges[ranges.length - 1].end, end);
    }
  }

  const output: string[] = [];
  ranges.forEach((range, index) => {
    if (index > 0) {
      output.push('...');
    }
    for (let i = range.start; i <= range.end; i += 1) {
      output.push(diff[i]);
    }
  });

  return output;
}

