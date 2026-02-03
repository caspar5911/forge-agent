/** Workspace file listing helpers. */
import * as fs from 'fs';
import * as path from 'path';

/** List workspace files with a depth and count cap, skipping common large folders. */
export function listWorkspaceFiles(rootPath: string, maxDepth: number, maxFiles: number): string[] {
  const results: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];

  while (stack.length > 0 && results.length < maxFiles) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') {
        continue;
      }
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) {
          stack.push({ dir: fullPath, depth: current.depth + 1 });
        }
      } else {
        results.push(path.relative(rootPath, fullPath));
        if (results.length >= maxFiles) {
          break;
        }
      }
    }
  }

  return results;
}
