import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Forge');
  const command = vscode.commands.registerCommand('forge.run', () => {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const activeEditorFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? null;
    const files: string[] = [];
    let packageJsonPath: string | null = null;
    let packageJson: unknown = null;
    let packageManager: string | null = null;
    let frontendFramework: string | null = null;
    let backendFramework: string | null = null;

    if (rootPath) {
      const packageJsonCandidates: string[] = [];
      const maxDepth = 2;
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
          if (entry.name === 'node_modules' || entry.name === '.git') {
            continue;
          }
          const fullPath = path.join(current.dir, entry.name);
          if (entry.isDirectory()) {
            if (current.depth < maxDepth) {
              stack.push({ dir: fullPath, depth: current.depth + 1 });
            }
          } else {
            files.push(path.relative(rootPath, fullPath));
            if (entry.name === 'package.json') {
              packageJsonCandidates.push(fullPath);
            }
          }
        }
      }

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

      if (!packageJsonPath) {
        const rootPackageJsonPath = path.join(rootPath, 'package.json');
        if (fs.existsSync(rootPackageJsonPath)) {
          packageJsonPath = rootPackageJsonPath;
        }
      }

      if (!packageJsonPath && packageJsonCandidates.length === 1) {
        packageJsonPath = packageJsonCandidates[0];
      }

      if (packageJsonPath) {
        try {
          const raw = fs.readFileSync(packageJsonPath, 'utf8');
          packageJson = JSON.parse(raw) as unknown;
        } catch {
          packageJson = null;
        }
      }

      if (packageJson && typeof packageJson === 'object') {
        const pkg = packageJson as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          packageManager?: string;
        };
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

        if (typeof pkg.packageManager === 'string') {
          packageManager = pkg.packageManager.split('@')[0] ?? null;
        }
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

    const contextObject = {
      workspaceRoot: rootPath,
      activeEditorFile,
      files,
      packageJson,
      packageManager,
      frontendFramework,
      backendFramework
    };

    output.clear();
    output.appendLine(JSON.stringify(contextObject, null, 2));
    output.show(true);

    void vscode.window.showInformationMessage('Forge context captured');
  });

  context.subscriptions.push(command);
}

export function deactivate(): void {}
