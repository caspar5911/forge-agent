import * as vscode from 'vscode';
import type { ForgeUiApi } from './api';
import { getForgeHtml } from './template';

export class ForgeViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'forge.view';

  private view?: vscode.WebviewView;
  private onRun?: (instruction: string, history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>) => void;
  private onReady?: () => void;
  private onStop?: () => void;
  private pendingSelection?: (files: string[]) => void;
  private readonly extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    view.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'run' && typeof message.text === 'string') {
        this.onRun?.(message.text, Array.isArray(message.history) ? message.history : undefined);
      }
      if (message?.type === 'stop') {
        this.onStop?.();
      }
      if (message?.type === 'fileSelectionResult' && Array.isArray(message.files)) {
        this.pendingSelection?.(message.files);
        this.pendingSelection = undefined;
      }
      if (message?.type === 'clear') {
        view.webview.postMessage({ type: 'clear' });
      }
    });

    view.webview.html = getForgeHtml(view.webview);
    this.onReady?.();
  }

  setHandler(handler: (instruction: string, history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>) => void): void {
    this.onRun = handler;
  }

  setStopHandler(handler: () => void): void {
    this.onStop = handler;
  }

  requestFileSelection(files: string[], preselected: string[] = []): Promise<string[]> {
    return new Promise((resolve) => {
      this.pendingSelection = resolve;
      if (!this.view) {
        resolve([]);
        return;
      }
      this.view.webview.postMessage({ type: 'fileSelection', files, preselected });
    });
  }

  getApi(): ForgeUiApi {
    return {
      setStatus: (text) => this.view?.webview.postMessage({ type: 'status', text }),
      appendLog: (text) => this.view?.webview.postMessage({ type: 'log', text }),
      setActiveFile: (text) => this.view?.webview.postMessage({ type: 'activeFile', text }),
      appendDiff: (lines) => this.view?.webview.postMessage({ type: 'diff', lines }),
      startStream: (role) => this.view?.webview.postMessage({ type: 'streamStart', role }),
      appendStream: (text) => this.view?.webview.postMessage({ type: 'stream', text }),
      endStream: () => this.view?.webview.postMessage({ type: 'streamEnd' })
    };
  }

  setReadyHandler(handler: () => void): void {
    this.onReady = handler;
  }
}
