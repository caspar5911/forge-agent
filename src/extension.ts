/** Forge extension entrypoint: command wiring and UI setup. */
import * as vscode from 'vscode';
import { harvestContext, type ProjectContext } from './context';
import { applyLLMSettingsToEnv, startKeepAlive } from './extension/lifecycle';
import {
  cancelActiveRun,
  createForgeRuntimeState,
  runForge,
  updateActiveFile
} from './extension/runtime';
import { runGitCommit, runGitPush, runGitStage } from './forge/gitActions';
import { startWorkspaceIndexing } from './indexer/workspaceIndex';
import type { ForgeUiApi } from './ui/api';
import { ForgePanel } from './ui/panel';
import { ForgeViewProvider } from './ui/view';

/** Register commands, UI panels, and watchers for the Forge extension. */
export function activate(context: vscode.ExtensionContext): void {
  const runtime = createForgeRuntimeState();
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

    await runForge(runtime, instruction, output);
  });

  // Register the Forge UI command (webview panel).
  const uiCommand = vscode.commands.registerCommand('forge.ui', () => {
    const panel = ForgePanel.createOrShow();
    runtime.panelInstance = panel;
    const api = panel.getApi();
    panelApi = api;
    api.setStatus('Idle');
    panel.setHandler((instruction, history) => {
      void runForge(runtime, instruction, output, api, history);
    });
    panel.setStopHandler(() => {
      cancelActiveRun(runtime, api, output);
    });
    updateActiveFile(runtime, api);
  });

  const viewProvider = new ForgeViewProvider(context.extensionUri);
  runtime.viewProviderInstance = viewProvider;
  const viewRegistration = vscode.window.registerWebviewViewProvider(
    ForgeViewProvider.viewType,
    viewProvider
  );
  viewProvider.setHandler((instruction, history) => {
    void runForge(runtime, instruction, output, viewProvider.getApi(), history);
  });
  viewProvider.setStopHandler(() => {
    cancelActiveRun(runtime, viewProvider.getApi(), output);
  });
  viewProvider.setReadyHandler(() => {
    updateActiveFile(runtime, viewProvider.getApi());
  });

  // Register the Forge context command (Phase 1 harvesting).
  const contextCommand = vscode.commands.registerCommand('forge.context', () => {
    const contextObject = harvestContext();
    logContext(output, contextObject);
    void vscode.window.showInformationMessage('Forge context captured.');
  });

  const gitStageCommand = vscode.commands.registerCommand('forge.gitStage', async () => {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    if (!rootPath) {
      void vscode.window.showErrorMessage('Forge: Open a workspace folder first.');
      return;
    }
    await runGitStage(rootPath, output);
  });

  const gitCommitCommand = vscode.commands.registerCommand('forge.gitCommit', async () => {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    if (!rootPath) {
      void vscode.window.showErrorMessage('Forge: Open a workspace folder first.');
      return;
    }
    await runGitCommit(rootPath, output);
  });

  const gitPushCommand = vscode.commands.registerCommand('forge.gitPush', async () => {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    if (!rootPath) {
      void vscode.window.showErrorMessage('Forge: Open a workspace folder first.');
      return;
    }
    await runGitPush(rootPath, output);
  });

  const activeEditorWatcher = vscode.window.onDidChangeActiveTextEditor(() => {
    updateActiveFile(runtime, panelApi);
    updateActiveFile(runtime, viewProvider.getApi());
  });

  // Dispose commands when the extension deactivates.
  context.subscriptions.push(
    runCommand,
    uiCommand,
    viewRegistration,
    contextCommand,
    gitStageCommand,
    gitCommitCommand,
    gitPushCommand,
    configWatcher,
    activeEditorWatcher
  );
}

/** VS Code deactivate hook (kept for symmetry; no teardown required). */
export function deactivate(): void {}

/** Dump the harvested project context into the Output panel. */
function logContext(output: vscode.OutputChannel, contextObject: ProjectContext): void {
  output.clear();
  output.appendLine(JSON.stringify(contextObject, null, 2));
  output.show(true);
}
