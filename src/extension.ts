// Node utilities for filesystem access and paths.
import * as fs from 'fs';
import * as path from 'path';
// VS Code extension API.
import * as vscode from 'vscode';
// Context harvester for Phase 1.
import { harvestContext, type ProjectContext } from './context';
import { buildValidationOptions, runCommand } from './validation';
import { commitAll, getCurrentBranch, getDiffStat, getGitStatus, getRemotes, isGitRepo, push } from './git';
import type { ChatCompletionResponse, ChatMessage } from './llm/client';
import { callChatCompletion } from './llm/client';


export function activate(context: vscode.ExtensionContext): void {
  // Output channel visible in View -> Output.
  const output = vscode.window.createOutputChannel('Forge');

  // Sync VS Code settings into env vars for shared LLM configuration.
  applyLLMSettingsToEnv();
  const configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('forge')) {
      applyLLMSettingsToEnv();
    }
  });

  // Register the Forge run command (Phase 0 editing).
  const runCommand = vscode.commands.registerCommand('forge.run', async () => {
    output.clear();
    output.show(true);

    // Ensure we have an active editor file to target.
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      void vscode.window.showErrorMessage('Forge: Open a file to edit first.');
      return;
    }

    const activeFilePath = activeEditor.document.uri.fsPath;
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const relativePath = rootPath ? path.relative(rootPath, activeFilePath) : path.basename(activeFilePath);

    // Ask the user for the instruction.
    const instruction = await vscode.window.showInputBox({
      prompt: 'What should Forge do in the active file?',
      placeHolder: 'e.g., Add a create order button'
    });

    if (!instruction) {
      void vscode.window.showInformationMessage('Forge: No instruction provided.');
      return;
    }

    // Confirm the target file with the user.
    const confirmTarget = await vscode.window.showWarningMessage(
      `Forge will edit: ${relativePath}. Continue?`,
      'Continue',
      'Cancel'
    );

    if (confirmTarget !== 'Continue') {
      void vscode.window.showInformationMessage('Forge: Cancelled.');
      return;
    }

    // Read the current file content.
    let originalContent: string;
    try {
      originalContent = fs.readFileSync(activeFilePath, 'utf8');
    } catch (error) {
      output.appendLine(`Error reading file: ${String(error)}`);
      void vscode.window.showErrorMessage('Forge: Failed to read the active file.');
      return;
    }

    output.appendLine('Requesting updated file from the local LLM...');

    // Build the LLM prompt for full-file output.
    const messages = buildFullFileMessages(instruction, relativePath, originalContent);

    let updatedContent: string;
    try {
      const response = await callChatCompletion({}, messages);
      updatedContent = extractUpdatedFile(response);
    } catch (error) {
      output.appendLine(`LLM error: ${String(error)}`);
      void vscode.window.showErrorMessage('Forge: LLM request failed.');
      return;
    }

    if (updatedContent === originalContent) {
      void vscode.window.showInformationMessage('Forge: No changes produced.');
      return;
    }

    // Show a diff view to the user.
    try {
      const originalUri = vscode.Uri.file(activeFilePath);
      const updatedDoc = await vscode.workspace.openTextDocument({ content: updatedContent });
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        updatedDoc.uri,
        `Forge: Proposed Changes (${relativePath})`
      );
    } catch (error) {
      output.appendLine(`Diff view error: ${String(error)}`);
    }

    // Ask for approval before writing changes.
    const confirmApply = await vscode.window.showWarningMessage(
      'Apply the proposed changes to the file?',
      'Apply',
      'Cancel'
    );

    if (confirmApply !== 'Apply') {
      void vscode.window.showInformationMessage('Forge: Changes not applied.');
      return;
    }

    try {
      fs.writeFileSync(activeFilePath, updatedContent, 'utf8');
      void vscode.window.showInformationMessage('Forge: Changes applied.');
    } catch (error) {
      output.appendLine(`Write error: ${String(error)}`);
      void vscode.window.showErrorMessage('Forge: Failed to write the file.');
      return;
    }

    if (rootPath) {
      const validationOk = await maybeRunValidation(rootPath, output);
      if (!validationOk) {
        void vscode.window.showErrorMessage('Forge: Validation failed.');
        return;
      }

      await maybeRunGitWorkflow(rootPath, output);
    }
  });

  // Register the Forge context command (Phase 1 harvesting).
  const contextCommand = vscode.commands.registerCommand('forge.context', () => {
    const contextObject = harvestContext();
    logContext(output, contextObject);
    void vscode.window.showInformationMessage('Forge context captured.');
  });

  // Dispose commands when the extension deactivates.
  context.subscriptions.push(runCommand, contextCommand, configWatcher);
}

export function deactivate(): void {}

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

  if (endpoint && endpoint.trim().length > 0) {
    process.env.FORGE_LLM_ENDPOINT = endpoint.trim();
  }
  if (model && model.trim().length > 0) {
    process.env.FORGE_LLM_MODEL = model.trim();
  }
  if (apiKey && apiKey.trim().length > 0) {
    process.env.FORGE_LLM_API_KEY = apiKey.trim();
  }
}

async function maybeRunValidation(rootPath: string, output: vscode.OutputChannel): Promise<boolean> {
  const contextObject = harvestContext();
  const options = buildValidationOptions(contextObject.packageJson, contextObject.packageManager);
  const items = options.map((option) => ({
    label: option.label,
    description: option.command
  }));

  items.push({ label: 'Skip validation', description: '' });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a validation command to run'
  });

  if (!pick || pick.label === 'Skip validation') {
    return true;
  }

  const selected = options.find((option) => option.label === pick.label);
  if (!selected) {
    return true;
  }

  output.appendLine('Running validation...');
  try {
    const code = await runCommand(selected.command, rootPath, output);
    return code === 0;
  } catch (error) {
    output.appendLine(`Validation error: ${String(error)}`);
    return false;
  }
}

async function maybeRunGitWorkflow(rootPath: string, output: vscode.OutputChannel): Promise<void> {
  const proceed = await vscode.window.showWarningMessage(
    'Start Git workflow (status, commit, optional push)?',
    'Continue',
    'Skip'
  );

  if (proceed !== 'Continue') {
    return;
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

  const confirmCommit = await vscode.window.showWarningMessage(
    `Commit with message: "${message}"?`,
    'Commit',
    'Cancel'
  );

  if (confirmCommit !== 'Commit') {
    void vscode.window.showInformationMessage('Forge: Commit cancelled.');
    return;
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

  const confirmPush = await vscode.window.showWarningMessage(
    `Push to ${remote}/${branch}?`,
    'Push',
    'Skip'
  );

  if (confirmPush !== 'Push') {
    return;
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
