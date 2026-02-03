/** Shared logging helpers for output and UI panels. */
import * as vscode from 'vscode';
import type { ForgeUiApi } from '../ui/api';

/** Write a line to the output channel and UI log. */
export function logOutput(output: vscode.OutputChannel, panelApi: ForgeUiApi | undefined, text: string): void {
  output.appendLine(text);
  panelApi?.appendLog(text);
}

/** Log only when verboseLogs is enabled in settings. */
export function logVerbose(output: vscode.OutputChannel, panelApi: ForgeUiApi | undefined, text: string): void {
  const config = vscode.workspace.getConfiguration('forge');
  if (config.get<boolean>('verboseLogs') === true) {
    logOutput(output, panelApi, text);
  }
}

/** Check whether an error looks like an abort/cancel signal. */
export function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const message = String(error);
  return message.toLowerCase().includes('aborted');
}

/** Format a millisecond duration as "Xm Ys" or "Ys". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
