import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const command = vscode.commands.registerCommand('forge.run', () => {
    void vscode.window.showInformationMessage('Forge is alive');
  });

  context.subscriptions.push(command);
}

export function deactivate(): void {}
