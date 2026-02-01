import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand('forge.run', () => {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'No workspace folder';
    console.log(`Forge is alive: ${rootPath}`);
    void vscode.window.showInformationMessage(`Forge is alive: ${rootPath}`);
  });

  context.subscriptions.push(command);
}

export function deactivate(): void {}
