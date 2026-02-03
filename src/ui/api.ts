/** UI bridge contract used by Forge runtime to update the webview. */
export type ForgeUiApi = {
  setStatus: (text: string) => void;
  appendLog: (text: string) => void;
  setActiveFile: (text: string) => void;
  appendDiff: (lines: string[]) => void;
  appendPeek?: (entries: Array<{ kind: string; title: string; content: string; sensitive?: boolean }>) => void;
  startStream?: (role?: 'assistant' | 'system' | 'error') => void;
  appendStream?: (text: string) => void;
  endStream?: () => void;
};
