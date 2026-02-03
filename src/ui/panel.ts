/** Webview panel host for the Forge UI. */
import * as vscode from 'vscode';
import type { ForgeUiApi } from './api';
import { getForgeHtml } from './template';

/** Manages the Forge webview panel lifecycle and messaging. */
export class ForgePanel {
  private static currentPanel: ForgePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private onRun?: (instruction: string, history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>) => void;
  private onStop?: () => void;
  private pendingSelection?: (result: { files: string[]; cancelled: boolean } | null) => void;

  /** Create a panel or reveal the existing one. */
  static createOrShow(): ForgePanel {
    const existing = ForgePanel.currentPanel;
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel('forgePanel', 'Forge', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true
    });

    const instance = new ForgePanel(panel);
    ForgePanel.currentPanel = instance;
    return instance;
  }

  /** Dispose the current panel instance if it exists. */
  static disposeCurrent(): void {
    ForgePanel.currentPanel?.dispose();
  }

  /** Construct a panel instance and wire message handlers. */
  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;

    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'run' && typeof message.text === 'string') {
        this.onRun?.(message.text, Array.isArray(message.history) ? message.history : undefined);
      }
      if (message?.type === 'stop') {
        this.onStop?.();
      }
      if (message?.type === 'fileSelectionResult') {
        const files = Array.isArray(message.files) ? message.files : [];
        const cancelled = message.cancelled === true;
        this.pendingSelection?.({ files, cancelled });
        this.pendingSelection = undefined;
      }
      if (message?.type === 'clear') {
        this.panel.webview.postMessage({ type: 'clear' });
      }
    });

    this.panel.webview.html = getForgeHtml(this.panel.webview);
  }

  /** Register the handler invoked when the user submits a prompt. */
  setHandler(handler: (instruction: string, history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>) => void): void {
    this.onRun = handler;
  }

  /** Register the handler invoked when the user requests stop. */
  setStopHandler(handler: () => void): void {
    this.onStop = handler;
  }

  /** Provide the API used by runtime to update the webview UI. */
  getApi(): ForgeUiApi {
    return {
      setStatus: (text) => this.panel.webview.postMessage({ type: 'status', text }),
      appendLog: (text) => this.panel.webview.postMessage({ type: 'log', text }),
      setActiveFile: (text) => this.panel.webview.postMessage({ type: 'activeFile', text }),
      appendDiff: (lines) => this.panel.webview.postMessage({ type: 'diff', lines }),
      startStream: (role) => this.panel.webview.postMessage({ type: 'streamStart', role }),
      appendStream: (text) => this.panel.webview.postMessage({ type: 'stream', text }),
      endStream: () => this.panel.webview.postMessage({ type: 'streamEnd' })
    };
  }

  /** Ask the panel UI to present a file selection modal. */
  requestFileSelection(files: string[], preselected: string[] = []): Promise<{ files: string[]; cancelled: boolean } | null> {
    return new Promise((resolve) => {
      this.pendingSelection = resolve;
      this.panel.webview.postMessage({ type: 'fileSelection', files, preselected });
    });
  }

  /** Dispose the underlying webview panel and clear the singleton. */
  dispose(): void {
    ForgePanel.currentPanel = undefined;
    this.panel.dispose();
  }
}
