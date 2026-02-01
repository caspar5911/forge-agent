// Node utilities for filesystem access and HTTP requests.
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
// VS Code extension API.
import * as vscode from 'vscode';
// Context harvester for Phase 1.
import { harvestContext, type ProjectContext } from './context';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

const DEFAULT_LLM_ENDPOINT = 'http://127.0.0.1:8000/v1';
const DEFAULT_LLM_MODEL = 'Qwen/Qwen2.5-Coder-32B-Instruct-AWQ';

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

    output.appendLine('Requesting diff from the local LLM...');

    // Build the LLM prompt for a unified diff.
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are a coding assistant. Return ONLY a unified diff for the target file. ' +
          'Do not include explanations, code fences, or extra text. ' +
          'The diff must apply cleanly and only change the target file.'
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
          'Return a unified diff for the target file only.'
      }
    ];

    // Call the LLM server.
    const config = vscode.workspace.getConfiguration('forge');
    const endpoint = config.get<string>('llmEndpoint') ?? process.env.FORGE_LLM_ENDPOINT ?? DEFAULT_LLM_ENDPOINT;
    const model = config.get<string>('llmModel') ?? process.env.FORGE_LLM_MODEL ?? DEFAULT_LLM_MODEL;
    const apiKeySetting = config.get<string>('llmApiKey');
    const apiKey = apiKeySetting && apiKeySetting.trim().length > 0 ? apiKeySetting : process.env.FORGE_LLM_API_KEY;

    let diffText: string;
    try {
      const response = await callChatCompletion(endpoint, model, messages, apiKey);
      diffText = extractUnifiedDiff(response);
    } catch (error) {
      output.appendLine(`LLM error: ${String(error)}`);
      void vscode.window.showErrorMessage('Forge: LLM request failed.');
      return;
    }

    output.appendLine('Validating diff...');

    try {
      validateSingleFileDiff(diffText, relativePath);
    } catch (error) {
      output.appendLine(`Diff validation failed: ${String(error)}`);
      void vscode.window.showErrorMessage('Forge: Diff validation failed.');
      return;
    }

    let updatedContent: string;
    try {
      updatedContent = applyUnifiedDiff(originalContent, diffText);
    } catch (error) {
      output.appendLine(`Diff apply failed: ${String(error)}`);
      void vscode.window.showErrorMessage('Forge: Failed to apply the diff.');
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

async function callChatCompletion(
  endpoint: string,
  model: string,
  messages: ChatMessage[],
  apiKey?: string
): Promise<ChatCompletionResponse> {
  const url = new URL(endpoint.replace(/\/$/, '') + '/chat/completions');
  const body = JSON.stringify({
    model,
    messages,
    temperature: 0,
    stream: false
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body).toString()
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const isHttps = url.protocol === 'https:';
  const requestOptions: http.RequestOptions = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    headers
  };

  const requester = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = requester.request(requestOptions, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data) as ChatCompletionResponse);
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${String(error)}`));
        }
      });
    });

    req.on('error', (error) => reject(error));
    req.write(body);
    req.end();
  });
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

function extractUnifiedDiff(response: ChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content?.trim();
  if (!content) {
    const errorMessage = response.error?.message ?? 'No content returned by LLM.';
    throw new Error(errorMessage);
  }

  const fenced = content.match(/```(?:diff)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : content;

  if (!raw.includes('--- ') || !raw.includes('+++ ')) {
    throw new Error('LLM output does not contain a unified diff.');
  }

  return raw;
}

function normalizeDiffPath(diffPath: string): string {
  const cleaned = diffPath.replace(/^a\//, '').replace(/^b\//, '').replace(/^"|"$/g, '');
  return cleaned.replace(/\\/g, '/');
}

function matchesTarget(diffPath: string, target: string): boolean {
  const normalizedDiff = normalizeDiffPath(diffPath);
  const normalizedTarget = target.replace(/\\/g, '/');
  return normalizedDiff === normalizedTarget || normalizedDiff.endsWith(`/${normalizedTarget}`);
}

function validateSingleFileDiff(diffText: string, targetPath: string): void {
  const lines = diffText.split(/\r?\n/);
  const fileHeaders = lines.filter((line) => line.startsWith('--- '));
  if (fileHeaders.length !== 1) {
    throw new Error('Diff must contain exactly one file header.');
  }

  const oldLineIndex = lines.findIndex((line) => line.startsWith('--- '));
  const newLineIndex = lines.findIndex((line) => line.startsWith('+++ '));

  if (oldLineIndex === -1 || newLineIndex === -1 || newLineIndex <= oldLineIndex) {
    throw new Error('Diff headers are missing or out of order.');
  }

  const oldPath = lines[oldLineIndex].slice(4).trim();
  const newPath = lines[newLineIndex].slice(4).trim();

  if (oldPath === '/dev/null' || newPath === '/dev/null') {
    throw new Error('Diff must modify an existing file (no create/delete).');
  }

  if (!matchesTarget(oldPath, targetPath) || !matchesTarget(newPath, targetPath)) {
    throw new Error('Diff file path does not match the active file.');
  }

  const hasHunk = lines.some((line) => line.startsWith('@@ '));
  if (!hasHunk) {
    throw new Error('Diff contains no hunks.');
  }

  const extraHeaders = lines.filter((line, index) => index > newLineIndex && line.startsWith('--- '));
  if (extraHeaders.length > 0) {
    throw new Error('Diff contains multiple files.');
  }
}

function applyUnifiedDiff(originalText: string, diffText: string): string {
  const originalLines = originalText.replace(/\r\n/g, '\n').split('\n');
  const diffLines = diffText.replace(/\r\n/g, '\n').split('\n');

  const result: string[] = [];
  let originalIndex = 0;

  let i = 0;
  while (i < diffLines.length) {
    const line = diffLines[i];
    if (line.startsWith('@@ ')) {
      const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
      if (!match) {
        throw new Error(`Invalid hunk header: ${line}`);
      }

      const startOld = Number(match[1]);
      const oldStartIndex = Math.max(startOld - 1, 0);

      // Copy unchanged lines before the hunk.
      while (originalIndex < oldStartIndex && originalIndex < originalLines.length) {
        result.push(originalLines[originalIndex]);
        originalIndex += 1;
      }

      i += 1;
      // Apply hunk lines.
      while (i < diffLines.length && !diffLines[i].startsWith('@@ ')) {
        const hunkLine = diffLines[i];
        if (hunkLine.startsWith(' ')) {
          const content = hunkLine.slice(1);
          if (originalLines[originalIndex] !== content) {
            throw new Error('Context line mismatch while applying diff.');
          }
          result.push(content);
          originalIndex += 1;
        } else if (hunkLine.startsWith('-')) {
          const content = hunkLine.slice(1);
          if (originalLines[originalIndex] !== content) {
            throw new Error('Removal line mismatch while applying diff.');
          }
          originalIndex += 1;
        } else if (hunkLine.startsWith('+')) {
          result.push(hunkLine.slice(1));
        } else if (hunkLine.startsWith('\\')) {
          // Ignore "No newline at end of file" markers.
        } else {
          throw new Error(`Unexpected diff line: ${hunkLine}`);
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }

  // Append remaining original lines after the last hunk.
  while (originalIndex < originalLines.length) {
    result.push(originalLines[originalIndex]);
    originalIndex += 1;
  }

  return result.join('\n');
}
