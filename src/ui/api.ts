export type ForgeUiApi = {
  setStatus: (text: string) => void;
  appendLog: (text: string) => void;
  setActiveFile: (text: string) => void;
  appendDiff: (lines: string[]) => void;
};
