export type Intent = 'edit' | 'question' | 'fix';

export type ChatHistoryItem = { role: 'user' | 'assistant' | 'system'; content: string };

export type FileUpdate = {
  fullPath: string;
  relativePath: string;
  original: string;
  updated: string;
};

export type FileSelectionRequester = {
  requestFileSelection: (files: string[], preselected: string[]) => Promise<string[]>;
};
