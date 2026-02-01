// Node utilities for reading files and joining paths.
import * as fs from 'fs';
import * as path from 'path';
// VS Code extension API.
import * as vscode from 'vscode';

// Structured context snapshot for the current workspace.
export type ProjectContext = {
  workspaceRoot: string | null;
  activeEditorFile: string | null;
  files: string[];
  packageJson: unknown;
  packageManager: string | null;
  frontendFramework: string | null;
  backendFramework: string | null;
};

// Collect deterministic project context without using any LLM.
export function harvestContext(): ProjectContext {
  // Workspace root folder (or null if none).
  const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  // Currently active editor file (or null if none).
  const activeEditorFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? null;
  // Collected file list (relative to root).
  const files: string[] = [];
  // Resolved package.json path (if found).
  let packageJsonPath: string | null = null;
  // Parsed package.json content.
  let packageJson: unknown = null;
  // Detected package manager name.
  let packageManager: string | null = null;
  // Detected frontend framework name.
  let frontendFramework: string | null = null;
  // Detected backend framework name.
  let backendFramework: string | null = null;

  // Only scan if we have a workspace root.
  if (rootPath) {
    // Track any package.json files found during the scan.
    const packageJsonCandidates: string[] = [];
    // Limit how deep we scan.
    const maxDepth = 2;
    // Manual stack for depth-limited traversal.
    const stack: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
    while (stack.length > 0) {
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
        // Skip large or irrelevant folders.
        if (entry.name === 'node_modules' || entry.name === '.git') {
          continue;
        }
        const fullPath = path.join(current.dir, entry.name);
        if (entry.isDirectory()) {
          if (current.depth < maxDepth) {
            stack.push({ dir: fullPath, depth: current.depth + 1 });
          }
        } else {
          // Store relative file path.
          files.push(path.relative(rootPath, fullPath));
          // Track package.json files for later selection.
          if (entry.name === 'package.json') {
            packageJsonCandidates.push(fullPath);
          }
        }
      }
    }

    // Prefer a package.json near the active editor file.
    if (activeEditorFile) {
      const activeRelative = path.relative(rootPath, activeEditorFile);
      const activeInWorkspace = !activeRelative.startsWith('..') && !path.isAbsolute(activeRelative);
      if (activeInWorkspace) {
        let dir = path.dirname(activeEditorFile);
        while (true) {
          const candidate = path.join(dir, 'package.json');
          if (fs.existsSync(candidate)) {
            packageJsonPath = candidate;
            break;
          }
          if (dir === rootPath) {
            break;
          }
          const parent = path.dirname(dir);
          if (parent === dir) {
            break;
          }
          dir = parent;
        }
      }
    }

    // Fallback to a root package.json if present.
    if (!packageJsonPath) {
      const rootPackageJsonPath = path.join(rootPath, 'package.json');
      if (fs.existsSync(rootPackageJsonPath)) {
        packageJsonPath = rootPackageJsonPath;
      }
    }

    // If exactly one package.json was found, use it.
    if (!packageJsonPath && packageJsonCandidates.length === 1) {
      packageJsonPath = packageJsonCandidates[0];
    }

    // Safely parse package.json content.
    if (packageJsonPath) {
      try {
        const raw = fs.readFileSync(packageJsonPath, 'utf8');
        packageJson = JSON.parse(raw) as unknown;
      } catch {
        packageJson = null;
      }
    }

    // Detect package manager and frameworks from dependencies.
    if (packageJson && typeof packageJson === 'object') {
      const pkg = packageJson as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        packageManager?: string;
      };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

      // Use packageManager field if present.
      if (typeof pkg.packageManager === 'string') {
        packageManager = pkg.packageManager.split('@')[0] ?? null;
      }
      // Otherwise, infer from lockfiles near package.json.
      if (!packageManager) {
        const projectDir = packageJsonPath ? path.dirname(packageJsonPath) : rootPath;
        if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) {
          packageManager = 'pnpm';
        } else if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) {
          packageManager = 'yarn';
        } else if (fs.existsSync(path.join(projectDir, 'package-lock.json'))) {
          packageManager = 'npm';
        } else if (fs.existsSync(path.join(projectDir, 'bun.lockb')) || fs.existsSync(path.join(projectDir, 'bun.lock'))) {
          packageManager = 'bun';
        }
      }

      // Basic frontend framework detection.
      if ('next' in deps) {
        frontendFramework = 'next';
      } else if ('react' in deps) {
        frontendFramework = 'react';
      } else if ('vue' in deps) {
        frontendFramework = 'vue';
      } else if ('nuxt' in deps) {
        frontendFramework = 'nuxt';
      } else if ('@angular/core' in deps) {
        frontendFramework = 'angular';
      } else if ('svelte' in deps) {
        frontendFramework = 'svelte';
      } else if ('solid-js' in deps) {
        frontendFramework = 'solid';
      } else if ('astro' in deps) {
        frontendFramework = 'astro';
      }

      // Basic backend framework detection.
      if ('@nestjs/core' in deps) {
        backendFramework = 'nestjs';
      } else if ('express' in deps) {
        backendFramework = 'express';
      } else if ('fastify' in deps) {
        backendFramework = 'fastify';
      } else if ('koa' in deps) {
        backendFramework = 'koa';
      } else if ('@hapi/hapi' in deps) {
        backendFramework = 'hapi';
      } else if ('hono' in deps) {
        backendFramework = 'hono';
      }
    }
  }

  return {
    workspaceRoot: rootPath,
    activeEditorFile,
    files,
    packageJson,
    packageManager,
    frontendFramework,
    backendFramework
  };
}
