/** Webview view provider for the Forge sidebar UI. */
import * as vscode from 'vscode';
import type { ForgeUiApi } from './api';
import { getForgeHtml } from './template';

/** Provides the Forge sidebar view and handles its messaging. */
export class ForgeViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'forge.view';

  private view?: vscode.WebviewView;
  private onRun?: (instruction: string, history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>) => void;
  private onReady?: () => void;
  private onStop?: () => void;
  private pendingSelection?: (result: { files: string[]; cancelled: boolean } | null) => void;
  private readonly extensionUri: vscode.Uri;

  /** Create the view provider with the extension URI for resource loading. */
  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  /** Initialize the webview view and attach message handlers. */
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
      if (message?.type === 'fileSelectionResult') {
        const files = Array.isArray(message.files) ? message.files : [];
        const cancelled = message.cancelled === true;
        this.pendingSelection?.({ files, cancelled });
        this.pendingSelection = undefined;
      }
      if (message?.type === 'clear') {
        view.webview.postMessage({ type: 'clear' });
      }
    });

    view.webview.html = getForgeHtml(view.webview);
    this.onReady?.();
  }

  /** Register the handler invoked when the user submits a prompt. */
  setHandler(handler: (instruction: string, history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>) => void): void {
    this.onRun = handler;
  }

  /** Register the handler invoked when the user requests stop. */
  setStopHandler(handler: () => void): void {
    this.onStop = handler;
  }

  /** Ask the sidebar UI to present a file selection modal. */
  requestFileSelection(files: string[], preselected: string[] = []): Promise<{ files: string[]; cancelled: boolean } | null> {
    return new Promise((resolve) => {
      this.pendingSelection = resolve;
      if (!this.view) {
        resolve(null);
        return;
      }
      this.view.webview.postMessage({ type: 'fileSelection', files, preselected });
    });
  }

  /** Provide the API used by runtime to update the sidebar UI. */
  getApi(): ForgeUiApi {
    return {
      setStatus: (text) => this.view?.webview.postMessage({ type: 'status', text }),
      appendLog: (text) => this.view?.webview.postMessage({ type: 'log', text }),
      setActiveFile: (text) => this.view?.webview.postMessage({ type: 'activeFile', text }),
      appendDiff: (lines) => this.view?.webview.postMessage({ type: 'diff', lines }),
      appendPeek: (entries) => this.view?.webview.postMessage({ type: 'peek', entries }),
      startStream: (role) => this.view?.webview.postMessage({ type: 'streamStart', role }),
      appendStream: (text) => this.view?.webview.postMessage({ type: 'stream', text }),
      endStream: () => this.view?.webview.postMessage({ type: 'streamEnd' })
    };
  }

  /** Register a handler for when the view is ready. */
  setReadyHandler(handler: () => void): void {
    this.onReady = handler;
  }
}
