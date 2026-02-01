import { spawn } from 'child_process';
import type { OutputChannel } from 'vscode';

export type ValidationOption = {
  label: string;
  command: string;
};

export function buildValidationOptions(
  packageJson: unknown,
  packageManager: string | null
): ValidationOption[] {
  if (!packageJson || typeof packageJson !== 'object') {
    return [];
  }

  const scripts = (packageJson as { scripts?: Record<string, string> }).scripts ?? {};
  const options: ValidationOption[] = [];
  const prefix = buildScriptPrefix(packageManager);

  if (scripts.test) {
    options.push({ label: 'test', command: `${prefix} test` });
  }
  if (scripts.lint) {
    options.push({ label: 'lint', command: `${prefix} lint` });
  }
  if (scripts.typecheck) {
    options.push({ label: 'typecheck', command: `${prefix} typecheck` });
  }
  if (scripts.build) {
    options.push({ label: 'build', command: `${prefix} build` });
  }

  return options;
}

export type CommandResult = {
  code: number;
  output: string;
};

export function runCommand(command: string, cwd: string, output: OutputChannel): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    output.appendLine(`> ${command}`);
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let buffer = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      buffer += text;
      output.appendLine(text);
    });
    child.stderr.on('data', (data) => {
      const text = data.toString();
      buffer += text;
      output.appendLine(text);
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => resolve({ code: code ?? 0, output: buffer }));
  });
}

function buildScriptPrefix(packageManager: string | null): string {
  if (packageManager === 'yarn') {
    return 'yarn';
  }
  if (packageManager === 'pnpm') {
    return 'pnpm';
  }
  if (packageManager === 'bun') {
    return 'bun run';
  }
  return 'npm run';
}
