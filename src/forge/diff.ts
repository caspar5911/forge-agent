export function getLineChangeSummary(original: string, updated: string, label: string): string | null {
  const originalLines = original.split(/\r?\n/);
  const updatedLines = updated.split(/\r?\n/);
  const lcsTable = buildLcsTable(originalLines, updatedLines);
  const lcs = lcsTable[originalLines.length][updatedLines.length];
  const removed = originalLines.length - lcs;
  const added = updatedLines.length - lcs;
  const changed = added + removed;
  if (changed === 0) {
    return null;
  }
  return `Changed ${changed} lines (+${added} / -${removed}) in ${label}.`;
}

export function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  const table = buildLcsTable(a, b);
  return table[a.length][b.length];
}

export function buildInlineDiffPreview(original: string, updated: string, label: string): string[] | null {
  const originalLines = original.split(/\r?\n/);
  const updatedLines = updated.split(/\r?\n/);
  const diff = buildLineDiff(originalLines, updatedLines);
  const preview = buildDiffPreviewWithContext(diff, 3);

  if (preview.length === 0) {
    return null;
  }

  const maxLines = 240;
  const sliced = preview.slice(0, maxLines);
  if (preview.length > maxLines) {
    sliced.push(`... (${preview.length - maxLines} more lines)`);
  }

  return [`Diff preview (${label}):`, ...sliced];
}

export function buildLineDiff(originalLines: string[], updatedLines: string[]): string[] {
  const table = buildLcsTable(originalLines, updatedLines);
  const diff: string[] = [];
  let i = originalLines.length;
  let j = updatedLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && originalLines[i - 1] === updatedLines[j - 1]) {
      diff.push(` ${originalLines[i - 1]}`);
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      diff.push(`+${updatedLines[j - 1]}`);
      j -= 1;
    } else if (i > 0) {
      diff.push(`-${originalLines[i - 1]}`);
      i -= 1;
    }
  }

  return diff.reverse();
}

export function buildLcsTable(a: string[], b: string[]): number[][] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

export function buildDiffPreviewWithContext(diff: string[], contextLines: number): string[] {
  const changedIndexes: number[] = [];
  for (let i = 0; i < diff.length; i += 1) {
    if (diff[i].startsWith('+') || diff[i].startsWith('-')) {
      changedIndexes.push(i);
    }
  }

  if (changedIndexes.length === 0) {
    return [];
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (const idx of changedIndexes) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(diff.length - 1, idx + contextLines);
    if (ranges.length === 0 || start > ranges[ranges.length - 1].end + 1) {
      ranges.push({ start, end });
    } else {
      ranges[ranges.length - 1].end = Math.max(ranges[ranges.length - 1].end, end);
    }
  }

  const output: string[] = [];
  ranges.forEach((range, index) => {
    if (index > 0) {
      output.push('...');
    }
    for (let i = range.start; i <= range.end; i += 1) {
      output.push(diff[i]);
    }
  });

  return output;
}
