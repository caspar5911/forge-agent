import * as vscode from 'vscode';
import type { ForgeUiApi } from '../ui/api';

export function logOutput(output: vscode.OutputChannel, panelApi: ForgeUiApi | undefined, text: string): void {
  output.appendLine(text);
  panelApi?.appendLog(text);
}

export function logVerbose(output: vscode.OutputChannel, panelApi: ForgeUiApi | undefined, text: string): void {
  const config = vscode.workspace.getConfiguration('forge');
  if (config.get<boolean>('verboseLogs') === true) {
    logOutput(output, panelApi, text);
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const message = String(error);
  return message.toLowerCase().includes('aborted');
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
