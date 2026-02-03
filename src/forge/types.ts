/** Shared types for the Forge pipeline. */

/** High-level user intent classification. */
export type Intent = 'edit' | 'question' | 'fix';

/** Stored chat turn for history replay. */
export type ChatHistoryItem = { role: 'user' | 'assistant' | 'system'; content: string };

/** Full-file update payload produced by the LLM. */
export type FileUpdate = {
  fullPath: string;
  relativePath: string;
  original: string;
  updated: string;
};

/** Result payload from a file selection prompt. */
export type FileSelectionResult = {
  files: string[];
  cancelled: boolean;
};

/** Contract for UI components that can request file selections. */
export type FileSelectionRequester = {
  requestFileSelection: (files: string[], preselected: string[]) => Promise<FileSelectionResult | null>;
};
