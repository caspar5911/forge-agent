import * as path from 'path';
import * as vscode from 'vscode';
import { harvestContext } from '../context';

type IndexedSymbol = {
  name: string;
  kind: string;
  containerName: string | null;
  relativePath: string;
};

export type WorkspaceIndex = {
  generatedAt: string;
  symbols: IndexedSymbol[];
  files: string[];
};

let currentIndex: WorkspaceIndex | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

export function startWorkspaceIndexing(context: vscode.ExtensionContext): void {
  scheduleRefresh(0);

  const onSave = vscode.workspace.onDidSaveTextDocument(() => scheduleRefresh());
  const onChange = vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRefresh());
  const onOpen = vscode.workspace.onDidOpenTextDocument(() => scheduleRefresh());

  context.subscriptions.push(onSave, onChange, onOpen);
}

export function getWorkspaceIndex(): WorkspaceIndex | null {
  return currentIndex;
}

function scheduleRefresh(delayMs = 1500): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    void refreshIndex();
  }, delayMs);
}

async function refreshIndex(): Promise<void> {
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const context = harvestContext();
  const files = context.files ?? [];

  const rawSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider',
    ''
  );

  const symbols = (rawSymbols ?? [])
    .map((symbol) => {
      const relativePath = rootPath
        ? path.relative(rootPath, symbol.location.uri.fsPath)
        : path.basename(symbol.location.uri.fsPath);
      return {
        name: symbol.name,
        kind: vscode.SymbolKind[symbol.kind] ?? String(symbol.kind),
        containerName: symbol.containerName ?? null,
        relativePath
      };
    })
    .filter((symbol) => symbol.name && symbol.relativePath);

  currentIndex = {
    generatedAt: new Date().toISOString(),
    symbols,
    files
  };
}
